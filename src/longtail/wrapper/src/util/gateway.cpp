#include "gateway.h"

#include <curl/curl.h>
#include <errno.h>
#include <inttypes.h>
#include <longtail.h>
#include <longtail_platform.h>
#include <string.h>

#include <chrono>
#include <map>
#include <string>
#include <thread>

#include "token-refresh.h"

// Checkpoint storage gateway adapter (HTTP + Bearer JWT to the core server).
// Structurally identical to the S3 adapter (object storage: buffered writes,
// single PUT on close, OBJECT_STORAGE flag so FSBlockStore writes blocks
// directly with no temp+rename); only the HTTP/auth layer differs.

struct GatewayStorageAPI_OpenFile {
  char* m_Path;
  std::string m_WriteBuffer;
  int m_IsWriteMode;
};

struct CurlResponse {
  long status_code;
  std::string body;
  std::map<std::string, std::string> headers;
  std::string error;
};

struct GatewayUploadData {
  const void* data;
  size_t size;
  size_t pos;
};

static size_t GatewayReadCallback(char* buffer, size_t size, size_t nitems, void* userp) {
  struct GatewayUploadData* upload = static_cast<struct GatewayUploadData*>(userp);
  size_t remaining = upload->size - upload->pos;
  size_t copy = (size * nitems < remaining) ? size * nitems : remaining;
  if (copy > 0) {
    memcpy(buffer, static_cast<const char*>(upload->data) + upload->pos, copy);
    upload->pos += copy;
  }
  return copy;
}

static size_t GatewayWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
  size_t realsize = size * nmemb;
  std::string* str = static_cast<std::string*>(userp);
  str->append(static_cast<char*>(contents), realsize);
  return realsize;
}

static size_t GatewayHeaderCallback(char* buffer, size_t size, size_t nitems, void* userdata) {
  size_t realsize = size * nitems;
  auto* headers = static_cast<std::map<std::string, std::string>*>(userdata);
  std::string header(buffer, realsize);
  size_t colonPos = header.find(':');
  if (colonPos != std::string::npos) {
    std::string key = header.substr(0, colonPos);
    std::string value = header.substr(colonPos + 1);
    while (!value.empty() && (value[0] == ' ' || value[0] == '\t')) value.erase(0, 1);
    while (!value.empty() && (value.back() == '\r' || value.back() == '\n' || value.back() == ' ')) value.pop_back();
    for (auto& c : key) c = (char)tolower((unsigned char)c);
    (*headers)[key] = value;
  }
  return realsize;
}

// Thread-local curl handle for TCP connection reuse across requests.
struct GatewayThreadCurlHandle {
  CURL* handle;
  GatewayThreadCurlHandle() : handle(nullptr) {}
  ~GatewayThreadCurlHandle() {
    if (handle) {
      curl_easy_cleanup(handle);
      handle = nullptr;
    }
  }
};
static thread_local GatewayThreadCurlHandle tls_gateway_curl;

static CURL* GetCurlHandle() {
  if (!tls_gateway_curl.handle) {
    tls_gateway_curl.handle = curl_easy_init();
  } else {
    curl_easy_reset(tls_gateway_curl.handle);
  }
  if (tls_gateway_curl.handle) {
    curl_easy_setopt(tls_gateway_curl.handle, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(tls_gateway_curl.handle, CURLOPT_TCP_KEEPIDLE, 30L);
    curl_easy_setopt(tls_gateway_curl.handle, CURLOPT_TCP_KEEPINTVL, 15L);
  }
  return tls_gateway_curl.handle;
}

// Refresh the JWT if it is close to expiry. Reads the refreshed token written
// by the JS polling thread. The old JWT string is intentionally leaked to avoid
// use-after-free across concurrent worker threads.
static int Gateway_RefreshTokenIfNeeded(GatewayStorageAPI* api) {
  if (!api->m_Handle) return 0;
  int err = EnsureTokenFresh(api->m_Handle);
  if (err) return err;
  if (api->m_Handle->refreshedJwt[0] != '\0') {
    api->m_JWT = strdup(api->m_Handle->refreshedJwt);
    api->m_Handle->refreshedJwt[0] = '\0';
  }
  return 0;
}

static std::string GatewayBuildUrl(const char* gatewayUrl, const char* path) {
  std::string url(gatewayUrl);
  if (path && path[0] != '\0') {
    if (path[0] != '/') url += "/";
    url += path;
  }
  return url;
}

static struct curl_slist* GatewayAuthHeaders(const std::string& jwt, struct curl_slist* headers) {
  std::string auth = "Authorization: Bearer " + jwt;
  return curl_slist_append(headers, auth.c_str());
}

// ----------------------------------------------------------------------------
// HTTP helpers
// ----------------------------------------------------------------------------

static CurlResponse GatewayHttpHead(const std::string& url, const std::string& jwt) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = GatewayAuthHeaders(jwt, nullptr);
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, GatewayHeaderCallback);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, &response.headers);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "GatewayHttpHead curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }
  curl_slist_free_all(headers);
  return response;
}

static CurlResponse GatewayHttpGet(const std::string& url, const std::string& jwt) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = GatewayAuthHeaders(jwt, nullptr);
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, GatewayWriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "GatewayHttpGet curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }
  curl_slist_free_all(headers);
  return response;
}

static CurlResponse GatewayHttpPut(const std::string& url, const std::string& jwt,
                                   const void* data, size_t dataSize) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Content-Type: application/octet-stream");
  headers = GatewayAuthHeaders(jwt, headers);

  GatewayUploadData uploadData{data, dataSize, 0};

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_READFUNCTION, GatewayReadCallback);
  curl_easy_setopt(curl, CURLOPT_READDATA, &uploadData);
  curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)dataSize);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, GatewayWriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "GatewayHttpPut curl error: %s (url: %s)", response.error.c_str(), url.c_str())
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }
  curl_slist_free_all(headers);
  return response;
}

static CurlResponse GatewayHttpDelete(const std::string& url, const std::string& jwt) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = GetCurlHandle();
  if (!curl) {
    response.error = "Failed to get curl handle";
    return response;
  }

  struct curl_slist* headers = GatewayAuthHeaders(jwt, nullptr);
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, GatewayWriteCallback);
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
  return response;
}

// ----------------------------------------------------------------------------
// Longtail_StorageAPI implementation
// ----------------------------------------------------------------------------

static void GatewayStorageAPI_Dispose(struct Longtail_API* storage_api) {
  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  free(api->m_GatewayUrl);
  free(api->m_JWT);
  Longtail_Free(storage_api);
}

static int GatewayStorageAPI_OpenReadFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)Longtail_Alloc(
      "GatewayStorageAPI_OpenFile", sizeof(struct GatewayStorageAPI_OpenFile));
  if (!open_file) return ENOMEM;

  new (open_file) GatewayStorageAPI_OpenFile();
  open_file->m_Path = Longtail_Strdup(path);
  open_file->m_IsWriteMode = 0;
  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;
  return 0;
}

static int GatewayStorageAPI_GetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t* out_size) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_size != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  {
    int err = Gateway_RefreshTokenIfNeeded(api);
    if (err) return err;
  }
  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)f;

  std::string url = GatewayBuildUrl(api->m_GatewayUrl, open_file->m_Path);
  CurlResponse r = GatewayHttpHead(url, api->m_JWT);

  if (r.status_code >= 200 && r.status_code < 300) {
    auto it = r.headers.find("content-length");
    if (it != r.headers.end()) {
      *out_size = std::stoull(it->second);
      return 0;
    }
    return ENOENT;
  }
  if (r.status_code == 404) return ENOENT;
  return EIO;
}

static int GatewayStorageAPI_Read(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    void* output) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, output != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  {
    int err = Gateway_RefreshTokenIfNeeded(api);
    if (err) return err;
  }
  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)f;

  std::string url = GatewayBuildUrl(api->m_GatewayUrl, open_file->m_Path);
  CurlResponse r = GatewayHttpGet(url, api->m_JWT);

  if (r.status_code >= 200 && r.status_code < 300) {
    if (offset > r.body.length()) return EIO;
    uint64_t adjustedLength = r.body.length() - offset;
    if (length < adjustedLength) adjustedLength = length;
    memcpy(output, r.body.c_str() + offset, adjustedLength);
    return 0;
  }
  if (r.status_code == 404) return ENOENT;
  return EIO;
}

static int GatewayStorageAPI_OpenWriteFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint64_t initial_size,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)Longtail_Alloc(
      "GatewayStorageAPI_OpenFile", sizeof(struct GatewayStorageAPI_OpenFile));
  if (!open_file) return ENOMEM;

  new (open_file) GatewayStorageAPI_OpenFile();
  open_file->m_Path = Longtail_Strdup(path);
  open_file->m_IsWriteMode = 1;
  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;
  return 0;
}

static int GatewayStorageAPI_Write(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    const void* input) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, input != 0, return EINVAL);

  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)f;
  // Buffer only; the PUT happens in CloseFile so multiple Write() calls (block
  // index + block data) coalesce into one request.
  size_t required = (size_t)offset + (size_t)length;
  if (required > open_file->m_WriteBuffer.size()) {
    open_file->m_WriteBuffer.resize(required, '\0');
  }
  memcpy(&open_file->m_WriteBuffer[(size_t)offset], input, (size_t)length);
  return 0;
}

static int GatewayStorageAPI_SetSize(struct Longtail_StorageAPI*, Longtail_StorageAPI_HOpenFile, uint64_t) {
  return 0;
}

static int GatewayStorageAPI_SetPermissions(struct Longtail_StorageAPI*, const char*, uint16_t) {
  return 0;
}

static int GatewayStorageAPI_GetPermissions(struct Longtail_StorageAPI*, const char*, uint16_t* out_permissions) {
  if (out_permissions) *out_permissions = 0644;
  return 0;
}

static void GatewayStorageAPI_CloseFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HOpenFile f) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return);

  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)f;

  if (open_file->m_IsWriteMode && !open_file->m_WriteBuffer.empty()) {
    struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
    Gateway_RefreshTokenIfNeeded(api);
    std::string url = GatewayBuildUrl(api->m_GatewayUrl, open_file->m_Path);
    CurlResponse r = GatewayHttpPut(url, api->m_JWT,
                                    open_file->m_WriteBuffer.data(), open_file->m_WriteBuffer.size());
    if (r.status_code < 200 || r.status_code >= 300) {
      LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "GatewayStorageAPI_CloseFile: PUT failed HTTP %ld, curl_error: %s, path: %s",
                   r.status_code, r.error.c_str(), open_file->m_Path)
    }
  }

  Longtail_Free(open_file->m_Path);
  open_file->~GatewayStorageAPI_OpenFile();
  Longtail_Free(open_file);
}

static int GatewayStorageAPI_CreateDir(struct Longtail_StorageAPI*, const char*) {
  return 0;  // no directories in the gateway/object model
}

static int GatewayStorageAPI_RenameFile(struct Longtail_StorageAPI* storage_api, const char* source_path, const char* target_path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, source_path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, target_path != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  {
    int err = Gateway_RefreshTokenIfNeeded(api);
    if (err) return err;
  }

  // The gateway protocol has no server-side copy. With OBJECT_STORAGE set,
  // blocks write directly to the final path, so RenameFile is rarely hit (only
  // non-block files). Implement it as GET + PUT + DELETE.
  std::string sourceUrl = GatewayBuildUrl(api->m_GatewayUrl, source_path);
  std::string targetUrl = GatewayBuildUrl(api->m_GatewayUrl, target_path);

  CurlResponse get = GatewayHttpGet(sourceUrl, api->m_JWT);
  if (get.status_code < 200 || get.status_code >= 300) {
    return (get.status_code == 404) ? ENOENT : EIO;
  }
  CurlResponse put = GatewayHttpPut(targetUrl, api->m_JWT, get.body.data(), get.body.size());
  if (put.status_code < 200 || put.status_code >= 300) {
    return EIO;
  }
  CurlResponse del = GatewayHttpDelete(sourceUrl, api->m_JWT);
  if (del.status_code != 404 && (del.status_code < 200 || del.status_code >= 300)) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_WARNING, "GatewayStorageAPI_RenameFile: DELETE source failed HTTP %ld (non-fatal)", del.status_code)
  }
  return 0;
}

static char* GatewayStorageAPI_ConcatPath(struct Longtail_StorageAPI* storage_api, const char* root_path, const char* sub_path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, root_path != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, sub_path != 0, return 0);

  std::string result = std::string(root_path) + "/" + std::string(sub_path);
  char* path = (char*)Longtail_Alloc("ConcatPath", result.length() + 1);
  if (!path) return 0;
  strcpy(path, result.c_str());
  return path;
}

static int GatewayStorageAPI_IsDir(struct Longtail_StorageAPI*, const char*) {
  return 0;
}

static int GatewayStorageAPI_IsFile(struct Longtail_StorageAPI* storage_api, const char* path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  std::string url = GatewayBuildUrl(api->m_GatewayUrl, path);
  CurlResponse r = GatewayHttpHead(url, api->m_JWT);
  return (r.status_code >= 200 && r.status_code < 300) ? 1 : 0;
}

static int GatewayStorageAPI_RemoveDir(struct Longtail_StorageAPI*, const char*) {
  return 0;
}

static int GatewayStorageAPI_RemoveFile(struct Longtail_StorageAPI* storage_api, const char* path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  std::string url = GatewayBuildUrl(api->m_GatewayUrl, path);
  CurlResponse r = GatewayHttpDelete(url, api->m_JWT);
  if (r.status_code >= 200 && r.status_code < 300) return 0;
  if (r.status_code == 404) return 0;
  return EIO;
}

static int GatewayStorageAPI_StartFind(struct Longtail_StorageAPI*, const char*, Longtail_StorageAPI_HIterator*) {
  return ENOENT;
}

static int GatewayStorageAPI_FindNext(struct Longtail_StorageAPI*, Longtail_StorageAPI_HIterator) {
  return ENOENT;
}

static void GatewayStorageAPI_CloseFind(struct Longtail_StorageAPI*, Longtail_StorageAPI_HIterator) {
}

static int GatewayStorageAPI_GetEntryProperties(
    struct Longtail_StorageAPI*, Longtail_StorageAPI_HIterator, struct Longtail_StorageAPI_EntryProperties*) {
  return ENOENT;
}

static int GatewayStorageAPI_LockFile(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HLockFile* out_lock_file) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, path != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, out_lock_file != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;

  char* lock_path = (char*)Longtail_Alloc("GatewayStorageAPI_LockFile", strlen(path) + 5 + 1);
  if (!lock_path) return ENOMEM;
  strcpy(lock_path, path);
  strcat(lock_path, ".lock");

  while (GatewayStorageAPI_IsFile(storage_api, lock_path)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)Longtail_Alloc(
      "GatewayStorageAPI_LockFile", sizeof(struct GatewayStorageAPI_OpenFile));
  if (!open_file) {
    Longtail_Free(lock_path);
    return ENOMEM;
  }

  std::string url = GatewayBuildUrl(api->m_GatewayUrl, lock_path);
  const char lockData[] = "lock";
  CurlResponse r = GatewayHttpPut(url, api->m_JWT, lockData, 4);

  if (r.status_code >= 200 && r.status_code < 300) {
    memset(open_file, 0, sizeof(struct GatewayStorageAPI_OpenFile));
    open_file->m_Path = lock_path;
    *out_lock_file = (Longtail_StorageAPI_HLockFile)open_file;
    return 0;
  }
  Longtail_Free(lock_path);
  Longtail_Free(open_file);
  return EIO;
}

static int GatewayStorageAPI_UnlockFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HLockFile lock_file) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, lock_file != 0, return EINVAL);

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  GatewayStorageAPI_OpenFile* open_file = (struct GatewayStorageAPI_OpenFile*)lock_file;

  std::string url = GatewayBuildUrl(api->m_GatewayUrl, open_file->m_Path);
  CurlResponse r = GatewayHttpDelete(url, api->m_JWT);

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);
  return (r.status_code == 404 || (r.status_code >= 200 && r.status_code < 300)) ? 0 : EIO;
}

static char* GatewayStorageAPI_GetParentPath(struct Longtail_StorageAPI* storage_api, const char* path) {
  struct Longtail_LogContextFmt_Private* ctx = 0;
  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return 0);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return 0);
  return Longtail_GetParentPath(path);
}

static int GatewayStorageAPI_MapFile(struct Longtail_StorageAPI*, Longtail_StorageAPI_HOpenFile, uint64_t, uint64_t, Longtail_StorageAPI_HFileMap*, const void**) {
  return ENOTSUP;
}

static void GatewayStorageAPI_UnmapFile(struct Longtail_StorageAPI*, Longtail_StorageAPI_HFileMap) {
}

static int GatewayStorageAPI_Init(void* mem, struct Longtail_StorageAPI** out_storage_api) {
  struct Longtail_StorageAPI* api = Longtail_MakeStorageAPI(
      mem,
      GatewayStorageAPI_Dispose,
      GatewayStorageAPI_OpenReadFile,
      GatewayStorageAPI_GetSize,
      GatewayStorageAPI_Read,
      GatewayStorageAPI_OpenWriteFile,
      GatewayStorageAPI_Write,
      GatewayStorageAPI_SetSize,
      GatewayStorageAPI_SetPermissions,
      GatewayStorageAPI_GetPermissions,
      GatewayStorageAPI_CloseFile,
      GatewayStorageAPI_CreateDir,
      GatewayStorageAPI_RenameFile,
      GatewayStorageAPI_ConcatPath,
      GatewayStorageAPI_IsDir,
      GatewayStorageAPI_IsFile,
      GatewayStorageAPI_RemoveDir,
      GatewayStorageAPI_RemoveFile,
      GatewayStorageAPI_StartFind,
      GatewayStorageAPI_FindNext,
      GatewayStorageAPI_CloseFind,
      GatewayStorageAPI_GetEntryProperties,
      GatewayStorageAPI_LockFile,
      GatewayStorageAPI_UnlockFile,
      GatewayStorageAPI_GetParentPath,
      GatewayStorageAPI_MapFile,
      GatewayStorageAPI_UnmapFile);
  *out_storage_api = api;
  return 0;
}

struct Longtail_StorageAPI* CreateGatewayStorageAPI(
    const char* gatewayUrl,
    const char* jwt,
    struct WrapperAsyncHandle* handle,
    uint64_t tokenExpirationMs) {
  MAKE_LOG_CONTEXT(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  void* mem = Longtail_Alloc("GatewayStorageAPI", sizeof(struct GatewayStorageAPI));
  if (!mem) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "Longtail_Alloc() failed with %d", ENOMEM)
    return 0;
  }
  struct Longtail_StorageAPI* storage_api;
  int err = GatewayStorageAPI_Init(mem, &storage_api);
  if (err) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "GatewayStorageAPI_Init() failed with %d", err)
    return 0;
  }

  struct GatewayStorageAPI* api = (struct GatewayStorageAPI*)storage_api;
  api->m_GatewayUrl = strdup(gatewayUrl);
  api->m_JWT = strdup(jwt ? jwt : "");
  api->m_Handle = handle;
  if (handle) {
    handle->tokenExpirationMs = tokenExpirationMs;
  }

  // Object storage semantics: FSBlockStore writes blocks directly (no rename).
  storage_api->m_StorageFlags = LONGTAIL_STORAGE_FLAG_OBJECT_STORAGE;

  return storage_api;
}
