#include "r2.h"
#include "token-refresh.h"

#include <curl/curl.h>
#include <errno.h>
#include <inttypes.h>
#include <longtail.h>
#include <longtail_platform.h>
#include <string.h>

#include <chrono>
#include <cstdio>
#include <iostream>
#include <map>
#include <string>
#include <thread>
#include <vector>

struct R2StorageAPI_OpenFile {
  char* m_Path;
  std::string m_WriteBuffer;
  int m_IsWriteMode;
};

// ============================================================================
// libcurl helper functions for R2 (S3-compatible with AWS SigV4)
// ============================================================================

struct CurlResponse {
  long status_code;
  std::string body;
  std::map<std::string, std::string> headers;
  std::string error;
};

struct R2UploadData {
  const void* data;
  size_t size;
  size_t pos;
};

// Bundles the credentials and SigV4 region needed to sign a single request.
// Region is "auto" for R2; a real AWS region (e.g. "us-east-1") when the
// endpoint points at AWS S3 or another S3-compatible provider.
struct R2Auth {
  std::string accessKeyId;
  std::string secretAccessKey;
  std::string sessionToken;
  std::string region;
};

static size_t R2ReadCallback(char* buffer, size_t size, size_t nitems, void* userp) {
  struct R2UploadData* upload = static_cast<struct R2UploadData*>(userp);
  size_t remaining = upload->size - upload->pos;
  size_t copy = (size * nitems < remaining) ? size * nitems : remaining;
  if (copy > 0) {
    memcpy(buffer, static_cast<const char*>(upload->data) + upload->pos, copy);
    upload->pos += copy;
  }
  return copy;
}

// Lets libcurl rewind the upload buffer. curl's AWS SigV4 implementation reads
// the body once to compute x-amz-content-sha256, then rewinds to send it; a PUT
// with a read callback needs a seek callback for that rewind to work.
static int R2SeekCallback(void* userp, curl_off_t offset, int origin) {
  struct R2UploadData* upload = static_cast<struct R2UploadData*>(userp);
  curl_off_t base;
  switch (origin) {
    case SEEK_SET: base = 0; break;
    case SEEK_CUR: base = (curl_off_t)upload->pos; break;
    case SEEK_END: base = (curl_off_t)upload->size; break;
    default: return CURL_SEEKFUNC_CANTSEEK;
  }
  curl_off_t target = base + offset;
  if (target < 0 || target > (curl_off_t)upload->size) {
    return CURL_SEEKFUNC_FAIL;
  }
  upload->pos = (size_t)target;
  return CURL_SEEKFUNC_OK;
}

// Percent-encode an S3 object key per RFC 3986. Unreserved characters
// (A-Za-z0-9-._~) pass through; everything else is escaped. Path separators
// are preserved when keepSlash is true so the key's "/" structure survives.
// SigV4's canonical URI requires this exact encoding, so the URL we hand curl
// must already be encoded (curl signs the path as given).
static std::string R2UriEncode(const std::string& in, bool keepSlash) {
  static const char hex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(in.size());
  for (unsigned char c : in) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '-' || c == '.' || c == '_' || c == '~' || (keepSlash && c == '/')) {
      out.push_back((char)c);
    } else {
      out.push_back('%');
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 0x0F]);
    }
  }
  return out;
}

// Extract the inner text of the first <tag>...</tag> from an S3 XML response.
// Used to pull the UploadId out of a CreateMultipartUpload response.
static std::string R2ExtractXmlTag(const std::string& xml, const std::string& tag) {
  std::string open = "<" + tag + ">";
  std::string close = "</" + tag + ">";
  size_t s = xml.find(open);
  if (s == std::string::npos) return "";
  s += open.size();
  size_t e = xml.find(close, s);
  if (e == std::string::npos) return "";
  return xml.substr(s, e - s);
}

static size_t R2WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
  size_t realsize = size * nmemb;
  std::string* str = static_cast<std::string*>(userp);
  str->append(static_cast<char*>(contents), realsize);
  return realsize;
}

static size_t R2HeaderCallback(char* buffer, size_t size, size_t nitems, void* userdata) {
  size_t realsize = size * nitems;
  std::map<std::string, std::string>* headers = static_cast<std::map<std::string, std::string>*>(userdata);

  std::string header(buffer, realsize);
  size_t colonPos = header.find(':');
  if (colonPos != std::string::npos) {
    std::string key = header.substr(0, colonPos);
    std::string value = header.substr(colonPos + 1);
    while (!value.empty() && (value[0] == ' ' || value[0] == '\t')) value.erase(0, 1);
    while (!value.empty() && (value.back() == '\r' || value.back() == '\n' || value.back() == ' ')) value.pop_back();
    // Lowercase the key for consistent lookup
    for (auto& c : key) c = (char)tolower((unsigned char)c);
    (*headers)[key] = value;
  }
  return realsize;
}

// Thread-local curl handle for TCP connection reuse across requests.
// curl_easy_reset keeps the connection pool alive while clearing options.
struct ThreadCurlHandle {
  CURL* handle;
  ThreadCurlHandle() : handle(nullptr) {}
  ~ThreadCurlHandle() { if (handle) { curl_easy_cleanup(handle); handle = nullptr; } }
};
static thread_local ThreadCurlHandle tls_curl;

static CURL* GetCurlHandle() {
  if (!tls_curl.handle) {
    tls_curl.handle = curl_easy_init();
  } else {
    curl_easy_reset(tls_curl.handle);
  }
  if (tls_curl.handle) {
    curl_easy_setopt(tls_curl.handle, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(tls_curl.handle, CURLOPT_TCP_KEEPIDLE, 30L);
    curl_easy_setopt(tls_curl.handle, CURLOPT_TCP_KEEPINTVL, 15L);
  }
  return tls_curl.handle;
}

// Configure curl handle with AWS SigV4 auth for R2 (or any S3 endpoint).
static void R2SetupAuth(CURL* curl, struct curl_slist** headers, const R2Auth& auth) {
  // Use libcurl's built-in AWS SigV4 signing (available since curl 7.75).
  // Format is "provider1:provider2:region:service". R2 uses region "auto";
  // AWS S3 needs the bucket's real region in the credential scope.
  std::string region = auth.region.empty() ? "auto" : auth.region;
  std::string sigv4 = "aws:amz:" + region + ":s3";
  // curl copies the option string internally, so a temporary is safe here.
  curl_easy_setopt(curl, CURLOPT_AWS_SIGV4, sigv4.c_str());

  // Set credentials
  std::string userpwd = auth.accessKeyId + ":" + auth.secretAccessKey;
  curl_easy_setopt(curl, CURLOPT_USERPWD, userpwd.c_str());

  // Set session token header if present
  if (!auth.sessionToken.empty()) {
    std::string tokenHeader = "x-amz-security-token: " + auth.sessionToken;
    *headers = curl_slist_append(*headers, tokenHeader.c_str());
  }
}

// Check if R2 STS credentials need refreshing. If so, requests new ones from
// the JS polling thread and updates the storage API's credential pointers.
// Old credential strings are intentionally leaked (a few hundred bytes per
// refresh) to avoid use-after-free in concurrent worker threads.
static int R2_RefreshCredentialsIfNeeded(R2StorageAPI* api) {
  if (!api->m_Handle) return 0;
  int err = EnsureTokenFresh(api->m_Handle);
  if (err) return err;
  if (api->m_Handle->refreshedR2AccessKeyId[0] != '\0') {
    api->m_AccessKeyId = strdup(api->m_Handle->refreshedR2AccessKeyId);
    api->m_Handle->refreshedR2AccessKeyId[0] = '\0';
    api->m_SecretAccessKey = strdup(api->m_Handle->refreshedR2SecretAccessKey);
    api->m_Handle->refreshedR2SecretAccessKey[0] = '\0';
    api->m_SessionToken = strdup(api->m_Handle->refreshedR2SessionToken);
    api->m_Handle->refreshedR2SessionToken[0] = '\0';
  }
  return 0;
}

// Build the full URL for an object in the R2 bucket
// endpoint: "https://{accountId}.r2.cloudflarestorage.com"
// bucket: "checkpoint-{repoId}"
// key: the object path (with leading slash stripped)
static std::string R2BuildUrl(const std::string& endpoint, const std::string& bucket, const std::string& path) {
  // Strip leading slash from path to form the S3 key
  std::string key = path;
  while (!key.empty() && key[0] == '/') {
    key.erase(0, 1);
  }

  // URL: endpoint/bucket/key, with the key percent-encoded (keeping "/" as the
  // path separator) so keys containing spaces or reserved characters produce a
  // valid URL and a matching SigV4 signature.
  return endpoint + "/" + bucket + "/" + R2UriEncode(key, /*keepSlash=*/true);
}

// Single-PUT objects above this size are split into a multipart upload.
// S3 and R2 both cap a single PUT at 5 GiB; staying well under that also keeps
// individual request retries cheap.
static const size_t R2_MULTIPART_THRESHOLD = 100ULL * 1024 * 1024;  // 100 MiB
// Part size for multipart uploads. Must be >= 5 MiB for all but the last part.
static const size_t R2_MULTIPART_PART_SIZE = 64ULL * 1024 * 1024;  // 64 MiB

// HTTP HEAD request with SigV4 auth
static CurlResponse R2HttpHead(const std::string& url, const R2Auth& auth) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpHead: url=%s", url.c_str())
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;
  R2SetupAuth(curl, &headers, auth);

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, R2HeaderCallback);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpHead curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    if (response.status_code < 200 || response.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpHead HTTP %ld (url: %s)", response.status_code, url.c_str())
    }
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpHead: status=%ld, error=%s", response.status_code, response.error.c_str())
  curl_slist_free_all(headers);

  return response;
}

// HTTP GET request with SigV4 auth. When rangeStart >= 0 a Range header is sent
// so only [rangeStart, rangeStart+rangeLength) is fetched instead of the whole
// object; pass rangeStart < 0 to fetch the full object.
static CurlResponse R2HttpGet(const std::string& url, const R2Auth& auth,
                              int64_t rangeStart = -1, int64_t rangeLength = -1) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpGet: url=%s", url.c_str())
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;
  R2SetupAuth(curl, &headers, auth);

  // Byte-range request: "Range: bytes=start-end" (end is inclusive).
  std::string rangeSpec;
  if (rangeStart >= 0 && rangeLength > 0) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%" PRId64 "-%" PRId64, rangeStart, rangeStart + rangeLength - 1);
    rangeSpec = buf;
    curl_easy_setopt(curl, CURLOPT_RANGE, rangeSpec.c_str());
  }

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, R2WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, R2HeaderCallback);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpGet curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    if (response.status_code < 200 || response.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpGet HTTP %ld (url: %s, body: %s)", response.status_code, url.c_str(), response.body.c_str())
    }
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpGet: status=%ld, body_size=%zu, error=%s", response.status_code, response.body.size(), response.error.c_str())
  curl_slist_free_all(headers);

  return response;
}

// HTTP PUT request with body data and SigV4 auth. extraHeaders are appended
// before signing (e.g. "If-None-Match: *" for an atomic create-if-absent, or
// "x-amz-copy-source: ..." for a server-side copy). Response headers are
// captured so callers can read the part ETag during a multipart upload.
static CurlResponse R2HttpPut(const std::string& url, const R2Auth& auth,
                              const void* data, size_t dataSize,
                              const std::vector<std::string>& extraHeaders = {}) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpPut: url=%s, dataSize=%zu", url.c_str(), dataSize)
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Content-Type: application/octet-stream");
  for (const std::string& h : extraHeaders) {
    headers = curl_slist_append(headers, h.c_str());
  }
  R2SetupAuth(curl, &headers, auth);

  R2UploadData uploadData;
  uploadData.data = data;
  uploadData.size = dataSize;
  uploadData.pos = 0;

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_READFUNCTION, R2ReadCallback);
  curl_easy_setopt(curl, CURLOPT_READDATA, &uploadData);
  // SigV4 reads the body to hash it, then rewinds via the seek callback.
  curl_easy_setopt(curl, CURLOPT_SEEKFUNCTION, R2SeekCallback);
  curl_easy_setopt(curl, CURLOPT_SEEKDATA, &uploadData);
  curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)dataSize);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, R2WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, R2HeaderCallback);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpPut curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    if (response.status_code < 200 || response.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpPut HTTP %ld (url: %s, body: %s)", response.status_code, url.c_str(), response.body.c_str())
    }
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpPut: status=%ld, error=%s", response.status_code, response.error.c_str())
  curl_slist_free_all(headers);

  return response;
}

// HTTP POST request with a body and SigV4 auth. Used for the multipart upload
// initiate (POST ?uploads) and complete (POST ?uploadId=...) operations.
static CurlResponse R2HttpPost(const std::string& url, const R2Auth& auth,
                               const std::string& body, const std::string& contentType) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpPost: url=%s, bodySize=%zu", url.c_str(), body.size())
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;
  std::string ctHeader = "Content-Type: " + contentType;
  headers = curl_slist_append(headers, ctHeader.c_str());
  R2SetupAuth(curl, &headers, auth);

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_POST, 1L);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.data());
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body.size());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, R2WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, R2HeaderCallback);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 120L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpPost curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    if (response.status_code < 200 || response.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpPost HTTP %ld (url: %s, body: %s)", response.status_code, url.c_str(), response.body.c_str())
    }
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpPost: status=%ld, error=%s", response.status_code, response.error.c_str())
  curl_slist_free_all(headers);

  return response;
}

// HTTP DELETE request with SigV4 auth
static CurlResponse R2HttpDelete(const std::string& url, const R2Auth& auth) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpDelete: url=%s", url.c_str())
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;
  R2SetupAuth(curl, &headers, auth);

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, R2WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpDelete curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    if (response.status_code < 200 || response.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpDelete HTTP %ld (url: %s, body: %s)", response.status_code, url.c_str(), response.body.c_str())
    }
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpDelete: status=%ld, error=%s", response.status_code, response.error.c_str())
  curl_slist_free_all(headers);

  return response;
}

// HTTP server-side COPY (S3 CopyObject) with SigV4 auth.
// Uses PUT with x-amz-copy-source header (no data transfer to/from client).
static CurlResponse R2HttpCopy(const std::string& targetUrl, const std::string& bucket,
                               const std::string& sourceKey, const R2Auth& auth) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpCopy: target=%s, source=/%s/%s", targetUrl.c_str(), bucket.c_str(), sourceKey.c_str())
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;

  // Strip leading slash from source key
  std::string cleanKey = sourceKey;
  while (!cleanKey.empty() && cleanKey[0] == '/') {
    cleanKey.erase(0, 1);
  }
  // x-amz-copy-source must be URL-encoded (keeping "/") so source keys with
  // spaces or reserved characters resolve correctly and match the signature.
  std::string copySource = "/" + bucket + "/" + R2UriEncode(cleanKey, /*keepSlash=*/true);
  std::string copyHeader = "x-amz-copy-source: " + copySource;
  headers = curl_slist_append(headers, copyHeader.c_str());

  R2SetupAuth(curl, &headers, auth);

  curl_easy_setopt(curl, CURLOPT_URL, targetUrl.c_str());
  curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
  curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)0);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, R2WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 60L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpCopy curl error: %s (target: %s)", response.error.c_str(), targetUrl.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
    if (response.status_code < 200 || response.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2HttpCopy HTTP %ld (target: %s, body: %s)", response.status_code, targetUrl.c_str(), response.body.c_str())
    }
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2HttpCopy: status=%ld, error=%s", response.status_code, response.error.c_str())
  curl_slist_free_all(headers);

  return response;
}

// Upload a large object as an S3 multipart upload: initiate, PUT each part,
// then complete. On any failure the upload is aborted so no orphaned parts are
// billed. Returns 0 on success or an errno-style code on failure.
static int R2MultipartUpload(const std::string& objectUrl, const R2Auth& auth,
                             const void* data, size_t size) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2MultipartUpload: url=%s, size=%zu", objectUrl.c_str(), size)

  // 1. Initiate the multipart upload and read back the UploadId.
  CurlResponse init = R2HttpPost(objectUrl + "?uploads", auth, "", "application/octet-stream");
  if (init.status_code < 200 || init.status_code >= 300) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2MultipartUpload: initiate failed HTTP %ld", init.status_code)
    return EIO;
  }
  std::string uploadId = R2ExtractXmlTag(init.body, "UploadId");
  if (uploadId.empty()) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2MultipartUpload: no UploadId in response: %s", init.body.c_str())
    return EIO;
  }
  // The UploadId goes into the query string, so encode it (no "/" exemption).
  std::string encodedId = R2UriEncode(uploadId, /*keepSlash=*/false);

  // 2. Upload each part, collecting (PartNumber, ETag) for the completion body.
  std::string completeXml = "<CompleteMultipartUpload>";
  const char* base = static_cast<const char*>(data);
  size_t pos = 0;
  int partNumber = 1;
  while (pos < size) {
    size_t partSize = (size - pos < R2_MULTIPART_PART_SIZE) ? (size - pos) : R2_MULTIPART_PART_SIZE;
    char partUrl[2048];
    snprintf(partUrl, sizeof(partUrl), "%s?partNumber=%d&uploadId=%s", objectUrl.c_str(), partNumber, encodedId.c_str());

    CurlResponse part = R2HttpPut(partUrl, auth, base + pos, partSize);
    if (part.status_code < 200 || part.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2MultipartUpload: part %d failed HTTP %ld", partNumber, part.status_code)
      R2HttpDelete(objectUrl + "?uploadId=" + encodedId, auth);  // abort
      return EIO;
    }
    auto it = part.headers.find("etag");
    if (it == part.headers.end() || it->second.empty()) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2MultipartUpload: part %d missing ETag", partNumber)
      R2HttpDelete(objectUrl + "?uploadId=" + encodedId, auth);  // abort
      return EIO;
    }
    completeXml += "<Part><PartNumber>" + std::to_string(partNumber) + "</PartNumber><ETag>" + it->second + "</ETag></Part>";
    pos += partSize;
    partNumber++;
  }
  completeXml += "</CompleteMultipartUpload>";

  // 3. Complete the upload. Note: S3 can return 200 with an <Error> body if the
  // assembly fails, so we inspect the body in addition to the status code.
  CurlResponse comp = R2HttpPost(objectUrl + "?uploadId=" + encodedId, auth, completeXml, "application/xml");
  if (comp.status_code < 200 || comp.status_code >= 300) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2MultipartUpload: complete failed HTTP %ld", comp.status_code)
    R2HttpDelete(objectUrl + "?uploadId=" + encodedId, auth);  // abort
    return EIO;
  }
  if (comp.body.find("<Error") != std::string::npos) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2MultipartUpload: complete returned error body: %s", comp.body.c_str())
    return EIO;
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2MultipartUpload: done, %d parts", partNumber - 1)
  return 0;
}

// Upload an object, choosing a single PUT for small payloads and a multipart
// upload for payloads above R2_MULTIPART_THRESHOLD (single PUT is capped at
// 5 GiB). Returns 0 on success or an errno-style code on failure.
static int R2PutObject(const std::string& objectUrl, const R2Auth& auth,
                       const void* data, size_t size) {
  if (size <= R2_MULTIPART_THRESHOLD) {
    CurlResponse r = R2HttpPut(objectUrl, auth, data, size);
    return (r.status_code >= 200 && r.status_code < 300) ? 0 : EIO;
  }
  return R2MultipartUpload(objectUrl, auth, data, size);
}

// ============================================================================
// R2 Storage API Implementation (Longtail_StorageAPI interface)
// ============================================================================

// Snapshot the current credentials and region into an R2Auth for one request.
static R2Auth R2AuthFromApi(struct R2StorageAPI* api) {
  R2Auth auth;
  auth.accessKeyId = api->m_AccessKeyId ? api->m_AccessKeyId : "";
  auth.secretAccessKey = api->m_SecretAccessKey ? api->m_SecretAccessKey : "";
  auth.sessionToken = api->m_SessionToken ? api->m_SessionToken : "";
  auth.region = api->m_Region ? api->m_Region : "auto";
  return auth;
}

static void R2StorageAPI_Dispose(struct Longtail_API* storage_api) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p")
  MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  free(r2_api->m_Endpoint);
  free(r2_api->m_BucketName);
  free(r2_api->m_AccessKeyId);
  free(r2_api->m_SecretAccessKey);
  free(r2_api->m_SessionToken);
  free(r2_api->m_Region);

  Longtail_Free(storage_api);
}

static int R2StorageAPI_OpenReadFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_OpenReadFile: path=%s", path)

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)Longtail_Alloc(
      "R2StorageAPI_OpenFile",
      sizeof(struct R2StorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  new (open_file) R2StorageAPI_OpenFile();
  open_file->m_Path = Longtail_Strdup(path);
  open_file->m_IsWriteMode = 0;
  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

  return 0;
}

static int R2StorageAPI_GetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t* out_size) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_size != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  { int err = R2_RefreshCredentialsIfNeeded(r2_api); if (err) return err; }
  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_GetSize: path=%s", open_file->m_Path)

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);
  CurlResponse r = R2HttpHead(url, R2AuthFromApi(r2_api));

  if (r.status_code >= 200 && r.status_code < 300) {
    auto it = r.headers.find("content-length");
    if (it != r.headers.end()) {
      *out_size = std::stoull(it->second);
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_GetSize: path=%s, size=%" PRIu64, open_file->m_Path, *out_size)
      return 0;
    }
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_GetSize: path=%s, no content-length header", open_file->m_Path)
    return ENOENT;
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_GetSize: path=%s, status=%ld", open_file->m_Path, r.status_code)
  if (r.status_code == 404) return ENOENT;
  return r.status_code > 0 ? EIO : EIO;
}

static int R2StorageAPI_Read(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    void* output) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, output != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  { int err = R2_RefreshCredentialsIfNeeded(r2_api); if (err) return err; }
  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);
  // Fetch only the requested byte range instead of the whole object. The server
  // returns 206 (Partial Content) with exactly the range, or 200 with the full
  // body if it ignores the Range header.
  CurlResponse r = R2HttpGet(url, R2AuthFromApi(r2_api), (int64_t)offset, (int64_t)length);

  if (r.status_code >= 200 && r.status_code < 300) {
    // A 206 response body starts at the requested offset; a 200 response (server
    // ignored Range) contains the whole object and must be sliced.
    size_t srcOffset = (r.status_code == 206) ? 0 : (size_t)offset;
    if (srcOffset > r.body.length()) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_Read: path=%s, offset %" PRIu64 " > body size %zu", open_file->m_Path, offset, r.body.length())
      return EIO;
    }

    uint64_t available = r.body.length() - srcOffset;
    // Longtail expects the full requested length; a short read is an error.
    if (available < length) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2StorageAPI_Read: path=%s, short read: got %" PRIu64 " of %" PRIu64 " bytes", open_file->m_Path, available, length)
      return EIO;
    }

    memcpy(output, r.body.c_str() + srcOffset, (size_t)length);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_Read: path=%s, read %" PRIu64 " bytes", open_file->m_Path, length)
    return 0;
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_Read: path=%s, failed status=%ld", open_file->m_Path, r.status_code)
  if (r.status_code == 404) return ENOENT;
  return EIO;
}

static int R2StorageAPI_OpenWriteFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint64_t initial_size,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)Longtail_Alloc(
      "R2StorageAPI_OpenFile",
      sizeof(struct R2StorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  new (open_file) R2StorageAPI_OpenFile();
  open_file->m_Path = Longtail_Strdup(path);
  open_file->m_IsWriteMode = 1;
  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_OpenWriteFile: path=%s, initial_size=%" PRIu64, path, initial_size)

  r2_api->m_NumAddedBlocks++;

  return 0;
}

static int R2StorageAPI_Write(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    const void* input) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, input != 0, return EINVAL);

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_Write: path=%s, offset=%" PRIu64 ", length=%" PRIu64 ", buffer_size=%zu",
               open_file->m_Path, offset, length, open_file->m_WriteBuffer.size())

  // Buffer only; the actual PUT to R2 happens in CloseFile.
  // Longtail_WriteStoredBlock calls Write twice (block index metadata, then
  // block content). Buffering avoids a redundant intermediate PUT of the
  // incomplete data. Combined with LONGTAIL_STORAGE_FLAG_OBJECT_STORAGE
  // (which skips the temp-file + rename in FSBlockStore), this gives us
  // 1 HEAD + 1 PUT = 2 HTTP requests per block.
  size_t required = (size_t)offset + (size_t)length;
  if (required > open_file->m_WriteBuffer.size()) {
    open_file->m_WriteBuffer.resize(required, '\0');
  }
  memcpy(&open_file->m_WriteBuffer[(size_t)offset], input, (size_t)length);

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_Write: buffered, path=%s, total_size=%zu", open_file->m_Path, open_file->m_WriteBuffer.size())
  return 0;
}

static int R2StorageAPI_SetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t length) {
  // No-op for R2
  return 0;
}

static int R2StorageAPI_SetPermissions(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint16_t permissions) {
  // No-op for R2
  return 0;
}

static int R2StorageAPI_GetPermissions(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint16_t* out_permissions) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  *out_permissions = 0644;
  return 0;
}

static void R2StorageAPI_CloseFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HOpenFile f) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return);

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_CloseFile: path=%s, is_write=%d, buffer_size=%zu",
               open_file->m_Path, open_file->m_IsWriteMode, open_file->m_WriteBuffer.size())

  // Flush the write buffer to R2.
  // Write() only buffers; the upload happens here so that multiple Write()
  // calls (e.g., block index + block data) are coalesced into one request.
  // R2PutObject uses a single PUT for small buffers and a multipart upload for
  // buffers larger than the single-PUT limit.
  if (open_file->m_IsWriteMode && !open_file->m_WriteBuffer.empty()) {
    struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
    R2_RefreshCredentialsIfNeeded(r2_api);
    std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);

    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_CloseFile: uploading %zu bytes to %s",
                 open_file->m_WriteBuffer.size(), open_file->m_Path)

    int err = R2PutObject(url, R2AuthFromApi(r2_api),
                          open_file->m_WriteBuffer.data(), open_file->m_WriteBuffer.size());
    if (err) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2StorageAPI_CloseFile: upload failed err=%d, path: %s",
                   err, open_file->m_Path)
    }
  }

  Longtail_Free(open_file->m_Path);
  open_file->~R2StorageAPI_OpenFile();
  Longtail_Free(open_file);
}

static int R2StorageAPI_CreateDir(struct Longtail_StorageAPI* storage_api, const char* path) {
  // R2/S3 doesn't have real directories (no-op)
  return 0;
}

static int R2StorageAPI_RenameFile(struct Longtail_StorageAPI* storage_api, const char* source_path, const char* target_path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, source_path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, target_path != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  { int err = R2_RefreshCredentialsIfNeeded(r2_api); if (err) return err; }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_RenameFile: source=%s, target=%s", source_path, target_path)

  // Use S3 CopyObject (server-side copy, no data transfer) instead of
  // the old GET+PUT+DELETE which downloaded the entire object back.
  // Note: With LONGTAIL_STORAGE_FLAG_OBJECT_STORAGE, FSBlockStore writes
  // directly to the final path and never calls RenameFile for blocks.
  // This codepath is only hit for non-block files (e.g., store index).
  std::string sourceUrl = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, source_path);
  std::string targetUrl = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, target_path);

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_RenameFile: CopyObject %s -> %s", source_path, target_path)

  R2Auth auth = R2AuthFromApi(r2_api);
  CurlResponse copyResp = R2HttpCopy(targetUrl, r2_api->m_BucketName, source_path, auth);
  if (copyResp.status_code < 200 || copyResp.status_code >= 300) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2StorageAPI_RenameFile: CopyObject failed HTTP %ld", copyResp.status_code)
    return (copyResp.status_code == 404) ? ENOENT : EIO;
  }

  // Delete source after successful copy
  CurlResponse delResp = R2HttpDelete(sourceUrl, auth);
  if (delResp.status_code != 404 && (delResp.status_code < 200 || delResp.status_code >= 300)) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_WARNING, "R2StorageAPI_RenameFile: DELETE source failed HTTP %ld (non-fatal)", delResp.status_code)
  }

  return 0;
}

static char* R2StorageAPI_ConcatPath(struct Longtail_StorageAPI* storage_api, const char* root_path, const char* sub_path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, root_path != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, sub_path != 0, return 0);

  std::string result = std::string(root_path) + "/" + std::string(sub_path);
  char* path = (char*)Longtail_Alloc("ConcatPath", result.length() + 1);
  if (!path) {
    return 0;
  }
  strcpy(path, result.c_str());
  return path;
}

static int R2StorageAPI_IsDir(struct Longtail_StorageAPI* storage_api, const char* path) {
  // R2/S3 doesn't have directories
  return 0;
}

static int R2StorageAPI_IsFile(struct Longtail_StorageAPI* storage_api, const char* path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, path);
  CurlResponse r = R2HttpHead(url, R2AuthFromApi(r2_api));

  int result = (r.status_code >= 200 && r.status_code < 300) ? 1 : 0;
  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_IsFile: path=%s, result=%d, status=%ld", path, result, r.status_code)
  return result;
}

static int R2StorageAPI_RemoveDir(struct Longtail_StorageAPI* storage_api, const char* path) {
  // R2/S3 doesn't have directories (no-op)
  return 0;
}

static int R2StorageAPI_RemoveFile(struct Longtail_StorageAPI* storage_api, const char* path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_RemoveFile: path=%s", path)

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, path);
  CurlResponse r = R2HttpDelete(url, R2AuthFromApi(r2_api));

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_RemoveFile: path=%s, status=%ld", path, r.status_code)
  if (r.status_code >= 200 && r.status_code < 300) return 0;
  if (r.status_code == 404) return 0;  // Already deleted
  return EIO;
}

// Directory iteration: not implemented (same as SeaweedFS)
static int R2StorageAPI_StartFind(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HIterator* out_iterator) {
  return ENOENT;
}

static int R2StorageAPI_FindNext(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HIterator iterator) {
  return ENOENT;
}

static void R2StorageAPI_CloseFind(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HIterator iterator) {
}

static int R2StorageAPI_GetEntryProperties(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HIterator iterator,
    struct Longtail_StorageAPI_EntryProperties* out_properties) {
  return ENOENT;
}

static int R2StorageAPI_LockFile(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HLockFile* out_lock_file) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_lock_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, path != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, out_lock_file != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;

  char* lock_path = (char*)Longtail_Alloc("R2StorageAPI_LockFile", strlen(path) + 5 + 1);
  if (!lock_path) {
    return ENOMEM;
  }

  strcpy(lock_path, path);
  strcat(lock_path, ".lock");

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_LockFile: %s", lock_path);

  // Acquire the lock with an atomic create-if-absent: PUT with "If-None-Match: *"
  // succeeds only when the object does not already exist, so concurrent writers
  // cannot both win. A 412 (Precondition Failed) means another holder has the
  // lock; wait and retry. This replaces the old IsFile-then-PUT check, which had
  // a time-of-check/time-of-use race.
  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, lock_path);
  R2Auth auth = R2AuthFromApi(r2_api);
  const char lockData[] = "lock";
  const std::vector<std::string> condHeaders = {"If-None-Match: *"};
  while (true) {
    CurlResponse r = R2HttpPut(url, auth, lockData, 4, condHeaders);
    if (r.status_code >= 200 && r.status_code < 300) {
      break;  // acquired
    }
    if (r.status_code == 412 || r.status_code == 409) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      continue;  // held by someone else, retry
    }
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2StorageAPI_LockFile: PUT failed HTTP %ld, path: %s", r.status_code, lock_path)
    Longtail_Free(lock_path);
    return EIO;
  }

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)Longtail_Alloc(
      "R2StorageAPI_LockFile",
      sizeof(struct R2StorageAPI_OpenFile));

  if (!open_file) {
    // Release the lock we just took so it is not leaked.
    R2HttpDelete(url, auth);
    Longtail_Free(lock_path);
    return ENOMEM;
  }

  memset(open_file, 0, sizeof(struct R2StorageAPI_OpenFile));
  open_file->m_Path = lock_path;
  *out_lock_file = (Longtail_StorageAPI_HLockFile)open_file;
  return 0;
}

static int R2StorageAPI_UnlockFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HLockFile lock_file) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(lock_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, lock_file != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)lock_file;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "R2StorageAPI_UnlockFile: %s", url.c_str());

  CurlResponse r = R2HttpDelete(url, R2AuthFromApi(r2_api));

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);

  // 404 is OK: lock file might have been deleted already
  return (r.status_code == 404 || (r.status_code >= 200 && r.status_code < 300)) ? 0 : EIO;
}

static char* R2StorageAPI_GetParentPath(
    struct Longtail_StorageAPI* storage_api,
    const char* path) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_OFF);

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return 0);

  return Longtail_GetParentPath(path);
}

static int R2StorageAPI_MapFile(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    Longtail_StorageAPI_HFileMap* out_file_map,
    const void** out_data_ptr) {
  // Not supported for remote storage
  return ENOTSUP;
}

static void R2StorageAPI_UnmapFile(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HFileMap m) {
  // Not supported for remote storage
}

// ============================================================================
// R2 Storage API Init / Create
// ============================================================================

static int R2StorageAPI_Init(
    void* mem,
    struct Longtail_StorageAPI** out_storage_api) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(mem, "%p"),
      LONGTAIL_LOGFIELD(out_storage_api, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_VALIDATE_INPUT(ctx, mem != 0, return 0);
  struct Longtail_StorageAPI* api = Longtail_MakeStorageAPI(
      mem,
      R2StorageAPI_Dispose,
      R2StorageAPI_OpenReadFile,
      R2StorageAPI_GetSize,
      R2StorageAPI_Read,
      R2StorageAPI_OpenWriteFile,
      R2StorageAPI_Write,
      R2StorageAPI_SetSize,
      R2StorageAPI_SetPermissions,
      R2StorageAPI_GetPermissions,
      R2StorageAPI_CloseFile,
      R2StorageAPI_CreateDir,
      R2StorageAPI_RenameFile,
      R2StorageAPI_ConcatPath,
      R2StorageAPI_IsDir,
      R2StorageAPI_IsFile,
      R2StorageAPI_RemoveDir,
      R2StorageAPI_RemoveFile,
      R2StorageAPI_StartFind,
      R2StorageAPI_FindNext,
      R2StorageAPI_CloseFind,
      R2StorageAPI_GetEntryProperties,
      R2StorageAPI_LockFile,
      R2StorageAPI_UnlockFile,
      R2StorageAPI_GetParentPath,
      R2StorageAPI_MapFile,
      R2StorageAPI_UnmapFile);
  *out_storage_api = api;
  return 0;
}

struct Longtail_StorageAPI* CreateR2StorageAPI(
    const char* endpoint,
    const char* bucketName,
    const char* accessKeyId,
    const char* secretAccessKey,
    const char* sessionToken,
    struct WrapperAsyncHandle* handle,
    uint64_t tokenExpirationMs,
    const char* region) {
  MAKE_LOG_CONTEXT(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  void* mem = Longtail_Alloc("R2StorageAPI", sizeof(struct R2StorageAPI));
  if (!mem) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "Longtail_Alloc() failed with %d", ENOMEM)
    return 0;
  }
  struct Longtail_StorageAPI* storage_api;
  int err = R2StorageAPI_Init(mem, &storage_api);
  if (err) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2StorageAPI_Init() failed with %d", err)
    return 0;
  }

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  r2_api->m_Endpoint = strdup(endpoint);
  r2_api->m_BucketName = strdup(bucketName);
  r2_api->m_AccessKeyId = strdup(accessKeyId);
  r2_api->m_SecretAccessKey = strdup(secretAccessKey);
  r2_api->m_SessionToken = sessionToken ? strdup(sessionToken) : strdup("");
  r2_api->m_Region = strdup((region && region[0]) ? region : "auto");
  r2_api->m_NumAddedBlocks = 0;
  r2_api->m_Handle = handle;
  if (handle) {
    handle->tokenExpirationMs = tokenExpirationMs;
  }

  // Mark as object storage so FSBlockStore skips temp-file + rename pattern
  storage_api->m_StorageFlags = LONGTAIL_STORAGE_FLAG_OBJECT_STORAGE;

  return storage_api;
}
