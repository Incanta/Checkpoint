#include "r2.h"

#include <curl/curl.h>
#include <errno.h>
#include <inttypes.h>
#include <longtail.h>
#include <longtail_platform.h>
#include <string.h>

#include <chrono>
#include <iostream>
#include <map>
#include <string>
#include <thread>

struct R2StorageAPI_OpenFile {
  char* m_Path;
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

// Configure curl handle with AWS SigV4 auth for R2
static void R2SetupAuth(CURL* curl, struct curl_slist** headers,
                        const std::string& accessKeyId,
                        const std::string& secretAccessKey,
                        const std::string& sessionToken) {
  // Use libcurl's built-in AWS SigV4 signing (available since curl 7.75)
  curl_easy_setopt(curl, CURLOPT_AWS_SIGV4, "aws:amz:auto:s3");

  // Set credentials
  std::string userpwd = accessKeyId + ":" + secretAccessKey;
  curl_easy_setopt(curl, CURLOPT_USERPWD, userpwd.c_str());

  // Set session token header if present
  if (!sessionToken.empty()) {
    std::string tokenHeader = "x-amz-security-token: " + sessionToken;
    *headers = curl_slist_append(*headers, tokenHeader.c_str());
  }
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

  // URL: endpoint/bucket/key
  return endpoint + "/" + bucket + "/" + key;
}

// HTTP HEAD request with SigV4 auth
static CurlResponse R2HttpHead(const std::string& url,
                               const std::string& accessKeyId,
                               const std::string& secretAccessKey,
                               const std::string& sessionToken) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Connection: close");
  R2SetupAuth(curl, &headers, accessKeyId, secretAccessKey, sessionToken);

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
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  return response;
}

// HTTP GET request with SigV4 auth
static CurlResponse R2HttpGet(const std::string& url,
                              const std::string& accessKeyId,
                              const std::string& secretAccessKey,
                              const std::string& sessionToken) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Connection: close");
  R2SetupAuth(curl, &headers, accessKeyId, secretAccessKey, sessionToken);

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
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  return response;
}

// HTTP PUT request with body data and SigV4 auth
static CurlResponse R2HttpPut(const std::string& url,
                              const std::string& accessKeyId,
                              const std::string& secretAccessKey,
                              const std::string& sessionToken,
                              const void* data,
                              size_t dataSize) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Connection: close");
  headers = curl_slist_append(headers, "Content-Type: application/octet-stream");
  R2SetupAuth(curl, &headers, accessKeyId, secretAccessKey, sessionToken);

  R2UploadData uploadData;
  uploadData.data = data;
  uploadData.size = dataSize;
  uploadData.pos = 0;

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_READFUNCTION, R2ReadCallback);
  curl_easy_setopt(curl, CURLOPT_READDATA, &uploadData);
  curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)dataSize);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, R2WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
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

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  return response;
}

// HTTP DELETE request with SigV4 auth
static CurlResponse R2HttpDelete(const std::string& url,
                                 const std::string& accessKeyId,
                                 const std::string& secretAccessKey,
                                 const std::string& sessionToken) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Connection: close");
  R2SetupAuth(curl, &headers, accessKeyId, secretAccessKey, sessionToken);

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
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  return response;
}

// ============================================================================
// R2 Storage API Implementation (Longtail_StorageAPI interface)
// ============================================================================

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

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)Longtail_Alloc(
      "R2StorageAPI_OpenFile",
      sizeof(struct R2StorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  memset(open_file, 0, sizeof(struct R2StorageAPI_OpenFile));
  open_file->m_Path = Longtail_Strdup(path);
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
  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);
  CurlResponse r = R2HttpHead(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  if (r.status_code >= 200 && r.status_code < 300) {
    auto it = r.headers.find("content-length");
    if (it != r.headers.end()) {
      *out_size = std::stoull(it->second);
      return 0;
    }
    return ENOENT;
  }

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
  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);
  CurlResponse r = R2HttpGet(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  if (r.status_code >= 200 && r.status_code < 300) {
    if (offset > r.body.length()) {
      return EIO;
    }

    uint64_t adjustedLength = r.body.length() - offset;
    if (length < adjustedLength) {
      adjustedLength = length;
    }

    memcpy(output, r.body.c_str() + offset, adjustedLength);
    return 0;
  }

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

  memset(open_file, 0, sizeof(struct R2StorageAPI_OpenFile));
  open_file->m_Path = Longtail_Strdup(path);
  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

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

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;
  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)f;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, open_file->m_Path);

  // R2/S3 doesn't support append — for offset > 0 we need to read-modify-write.
  // However, in longtail's usage pattern, blocks are written as single whole objects
  // (Write is called once per OpenWriteFile), so offset is always 0 for block writes.
  // For the store index (store.lsi), it may be rewritten entirely.
  // We handle both cases: offset == 0 is a simple PUT; offset > 0 reads existing, appends, and PUTs.
  if (offset > 0) {
    // Read existing data
    CurlResponse existing = R2HttpGet(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);
    if (existing.status_code >= 200 && existing.status_code < 300) {
      // Extend the existing data
      std::string combined = existing.body;
      if (offset > combined.size()) {
        combined.resize((size_t)offset, '\0');
      }
      combined.resize((size_t)offset);
      combined.append(static_cast<const char*>(input), (size_t)length);

      CurlResponse r = R2HttpPut(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken,
                                 combined.data(), combined.size());
      return (r.status_code >= 200 && r.status_code < 300) ? 0 : EIO;
    } else if (existing.status_code == 404) {
      // File doesn't exist yet, write with padding
      std::string padded((size_t)offset, '\0');
      padded.append(static_cast<const char*>(input), (size_t)length);

      CurlResponse r = R2HttpPut(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken,
                                 padded.data(), padded.size());
      return (r.status_code >= 200 && r.status_code < 300) ? 0 : EIO;
    }
    return EIO;
  }

  CurlResponse r = R2HttpPut(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken,
                             input, (size_t)length);

  if (r.status_code < 200 || r.status_code >= 300) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "R2StorageAPI_Write failed: HTTP %ld, curl_error: %s, response: %s, path: %s",
                 r.status_code, r.error.c_str(), r.body.c_str(), open_file->m_Path)
    return EIO;
  }
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
  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);
}

static int R2StorageAPI_CreateDir(struct Longtail_StorageAPI* storage_api, const char* path) {
  // R2/S3 doesn't have real directories — no-op
  return 0;
}

static int R2StorageAPI_RenameFile(struct Longtail_StorageAPI* storage_api, const char* source_path, const char* target_path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, source_path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, target_path != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;

  // R2/S3 doesn't have native rename — copy then delete
  // First, read the source object
  std::string sourceUrl = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, source_path);
  CurlResponse readResp = R2HttpGet(sourceUrl, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  if (readResp.status_code < 200 || readResp.status_code >= 300) {
    return (readResp.status_code == 404) ? ENOENT : EIO;
  }

  // Write to target
  std::string targetUrl = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, target_path);
  CurlResponse writeResp = R2HttpPut(targetUrl, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken,
                                     readResp.body.data(), readResp.body.size());

  if (writeResp.status_code < 200 || writeResp.status_code >= 300) {
    return EIO;
  }

  // Delete source
  CurlResponse delResp = R2HttpDelete(sourceUrl, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  // 404 on delete is OK (source already gone)
  if (delResp.status_code != 404 && (delResp.status_code < 200 || delResp.status_code >= 300)) {
    return EIO;
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
  CurlResponse r = R2HttpHead(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  return (r.status_code >= 200 && r.status_code < 300) ? 1 : 0;
}

static int R2StorageAPI_RemoveDir(struct Longtail_StorageAPI* storage_api, const char* path) {
  // R2/S3 doesn't have directories — no-op
  return 0;
}

static int R2StorageAPI_RemoveFile(struct Longtail_StorageAPI* storage_api, const char* path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct R2StorageAPI* r2_api = (struct R2StorageAPI*)storage_api;

  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, path);
  CurlResponse r = R2HttpDelete(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  if (r.status_code >= 200 && r.status_code < 300) return 0;
  if (r.status_code == 404) return 0;  // Already deleted
  return EIO;
}

// Directory iteration — not implemented (same as SeaweedFS)
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

  // Wait for lock file to not exist
  while (R2StorageAPI_IsFile(storage_api, lock_path)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  R2StorageAPI_OpenFile* open_file = (struct R2StorageAPI_OpenFile*)Longtail_Alloc(
      "R2StorageAPI_LockFile",
      sizeof(struct R2StorageAPI_OpenFile));

  if (!open_file) {
    Longtail_Free(lock_path);
    return ENOMEM;
  }

  // Create lock file by PUTting an empty object
  std::string url = R2BuildUrl(r2_api->m_Endpoint, r2_api->m_BucketName, lock_path);
  const char lockData[] = "lock";
  CurlResponse r = R2HttpPut(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken,
                             lockData, 4);

  if (r.status_code >= 200 && r.status_code < 300) {
    memset(open_file, 0, sizeof(struct R2StorageAPI_OpenFile));
    open_file->m_Path = lock_path;
    *out_lock_file = (Longtail_StorageAPI_HLockFile)open_file;
    return 0;
  } else {
    Longtail_Free(lock_path);
    Longtail_Free(open_file);
    return EIO;
  }
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

  CurlResponse r = R2HttpDelete(url, r2_api->m_AccessKeyId, r2_api->m_SecretAccessKey, r2_api->m_SessionToken);

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);

  // 404 is OK — lock file might have been deleted already
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
    const char* sessionToken) {
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
  r2_api->m_SessionToken = strdup(sessionToken);
  r2_api->m_NumAddedBlocks = 0;

  return storage_api;
}
