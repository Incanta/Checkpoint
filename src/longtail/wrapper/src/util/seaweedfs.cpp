#include "seaweedfs.h"

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

#include "json.hpp"

using json = nlohmann::json;

struct SeaweedFSStorageAPI_OpenFile {
  char* m_Path;
};

// ============================================================================
// libcurl helper functions
// ============================================================================

struct CurlResponse {
  long status_code;
  std::string body;
  std::map<std::string, std::string> headers;
  std::string error;
};

// Callback for writing response body
static size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
  size_t realsize = size * nmemb;
  std::string* str = static_cast<std::string*>(userp);
  str->append(static_cast<char*>(contents), realsize);
  return realsize;
}

// Callback for writing response headers
static size_t HeaderCallback(char* buffer, size_t size, size_t nitems, void* userdata) {
  size_t realsize = size * nitems;
  std::map<std::string, std::string>* headers = static_cast<std::map<std::string, std::string>*>(userdata);

  std::string header(buffer, realsize);
  size_t colonPos = header.find(':');
  if (colonPos != std::string::npos) {
    std::string key = header.substr(0, colonPos);
    std::string value = header.substr(colonPos + 1);
    // Trim whitespace
    while (!value.empty() && (value[0] == ' ' || value[0] == '\t')) value.erase(0, 1);
    while (!value.empty() && (value.back() == '\r' || value.back() == '\n' || value.back() == ' ')) value.pop_back();
    (*headers)[key] = value;
  }
  return realsize;
}

// Perform HTTP HEAD request
static CurlResponse HttpHead(const std::string& url, const std::string& jwt) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  std::string authHeader = "Authorization: Bearer " + jwt;
  headers = curl_slist_append(headers, authHeader.c_str());
  headers = curl_slist_append(headers, "Connection: close");

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);  // HEAD request
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, HeaderCallback);
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

// Perform HTTP GET request
static CurlResponse HttpGet(const std::string& url, const std::string& jwt) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  std::string authHeader = "Authorization: Bearer " + jwt;
  headers = curl_slist_append(headers, authHeader.c_str());
  headers = curl_slist_append(headers, "Connection: close");

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, HeaderCallback);
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

// Perform HTTP POST request with multipart file upload
static CurlResponse HttpPostMultipart(const std::string& url, const std::string& jwt, const void* data, size_t dataSize, const char* filename) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  std::string authHeader = "Authorization: Bearer " + jwt;
  headers = curl_slist_append(headers, authHeader.c_str());
  headers = curl_slist_append(headers, "Connection: close");

  curl_mime* mime = curl_mime_init(curl);
  curl_mimepart* part = curl_mime_addpart(mime);
  curl_mime_name(part, "name");
  curl_mime_data(part, static_cast<const char*>(data), dataSize);
  curl_mime_filename(part, filename);

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_MIMEPOST, mime);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

  CURLcode res = curl_easy_perform(curl);
  if (res != CURLE_OK) {
    response.error = curl_easy_strerror(res);
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response.status_code);
  }

  curl_mime_free(mime);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  return response;
}

// Perform HTTP POST request (no body)
static CurlResponse HttpPost(const std::string& url, const std::string& jwt) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  std::string authHeader = "Authorization: Bearer " + jwt;
  headers = curl_slist_append(headers, authHeader.c_str());
  headers = curl_slist_append(headers, "Connection: close");

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_POST, 1L);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, 0L);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
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

// Perform HTTP DELETE request
static CurlResponse HttpDelete(const std::string& url, const std::string& jwt) {
  CurlResponse response;
  response.status_code = 0;

  CURL* curl = curl_easy_init();
  if (!curl) {
    response.error = "Failed to initialize curl";
    return response;
  }

  struct curl_slist* headers = nullptr;
  std::string authHeader = "Authorization: Bearer " + jwt;
  headers = curl_slist_append(headers, authHeader.c_str());
  headers = curl_slist_append(headers, "Connection: close");

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
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
// SeaweedFS Storage API Implementation
// ============================================================================

static void SeaweedFSStorageAPI_Dispose(struct Longtail_API* storage_api) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p")
  MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return);

  Longtail_Free(storage_api);
}

static int SeaweedFSStorageAPI_OpenReadFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_open_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)Longtail_Alloc(
      "SeaweedFSStorageAPI_OpenFile",
      sizeof(struct SeaweedFSStorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  memset(open_file, 0, sizeof(struct SeaweedFSStorageAPI_OpenFile));

  open_file->m_Path = Longtail_Strdup(path);

  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

  return 0;
}

static int SeaweedFSStorageAPI_GetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t* out_size) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(out_size, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_size != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;
  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path);

  CurlResponse r = HttpHead(url, seaweed_storage_api->m_JWT);

  if (r.status_code >= 200 && r.status_code < 300) {
    auto it = r.headers.find("Content-Length");
    if (it != r.headers.end()) {
      *out_size = std::stoull(it->second);
      return 0;
    }
    return ENOENT;
  }

  return r.status_code > 0 ? (int)r.status_code : EIO;
}

static int SeaweedFSStorageAPI_Read(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    void* output) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(offset, "%" PRIu64),
      LONGTAIL_LOGFIELD(length, "%" PRIu64),
      LONGTAIL_LOGFIELD(output, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, output != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;
  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path);

  CurlResponse r = HttpGet(url, seaweed_storage_api->m_JWT);

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

  return r.status_code > 0 ? (int)r.status_code : EIO;
}

static int SeaweedFSStorageAPI_OpenWriteFile(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint64_t initial_size,
    Longtail_StorageAPI_HOpenFile* out_open_file) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(initial_size, "%" PRIu64),
      LONGTAIL_LOGFIELD(out_open_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_open_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)Longtail_Alloc(
      "SeaweedFSStorageAPI_OpenFile",
      sizeof(struct SeaweedFSStorageAPI_OpenFile));

  if (!open_file) {
    return ENOMEM;
  }

  memset(open_file, 0, sizeof(struct SeaweedFSStorageAPI_OpenFile));

  open_file->m_Path = Longtail_Strdup(path);

  *out_open_file = (Longtail_StorageAPI_HOpenFile)open_file;

  seaweed_storage_api->m_NumAddedBlocks++;

  return 0;
}

static int SeaweedFSStorageAPI_Write(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    const void* input) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(offset, "%" PRIu64),
      LONGTAIL_LOGFIELD(length, "%" PRIu64),
      LONGTAIL_LOGFIELD(input, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, input != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;
  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path);

  if (offset > 0) {
    url += "?op=append";
  }

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "SeaweedFSStorageAPI_Write: %s", url.c_str());

  CurlResponse r = HttpPostMultipart(url, seaweed_storage_api->m_JWT, input, length, "chunk.bin");

  if (r.status_code >= 200 && r.status_code < 300) {
    return 0;
  }

  return r.status_code > 0 ? (int)r.status_code : EIO;
}

static int SeaweedFSStorageAPI_SetSize(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t length) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(length, "%" PRIu64)
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL);

  return 0;
}

static int SeaweedFSStorageAPI_SetPermissions(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint16_t permissions) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(permissions, "%u")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  return 0;
}

static int SeaweedFSStorageAPI_GetPermissions(
    struct Longtail_StorageAPI* storage_api,
    const char* path,
    uint16_t* out_permissions) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_permissions, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  *out_permissions = 0644;

  return 0;
}

static void SeaweedFSStorageAPI_CloseFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HOpenFile f) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return);
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return);

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)f;

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);
}

static int SeaweedFSStorageAPI_CreateDir(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  return 0;
}

static int SeaweedFSStorageAPI_RenameFile(struct Longtail_StorageAPI* storage_api, const char* source_path, const char* target_path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(source_path, "%s"),
      LONGTAIL_LOGFIELD(target_path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, source_path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, target_path != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(target_path) + "?mv.from=" + std::string(source_path);

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "SeaweedFSStorageAPI_RenameFile: %s", url.c_str());

  CurlResponse r = HttpPost(url, seaweed_storage_api->m_JWT);

  return (r.status_code >= 200 && r.status_code < 300) ? 0 : (r.status_code > 0 ? (int)r.status_code : EIO);
}

static char* SeaweedFSStorageAPI_ConcatPath(struct Longtail_StorageAPI* storage_api, const char* root_path, const char* sub_path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(root_path, "%s"),
      LONGTAIL_LOGFIELD(sub_path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

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

static int SeaweedFSStorageAPI_IsDir(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  // SeaweedFS doesn't have traditional directories
  return 0;
}

static int SeaweedFSStorageAPI_IsFile(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(path);

  CurlResponse r = HttpHead(url, seaweed_storage_api->m_JWT);

  return (r.status_code >= 200 && r.status_code < 300) ? 1 : 0;
}

static int SeaweedFSStorageAPI_RemoveDir(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  // SeaweedFS doesn't have traditional directories
  return 0;
}

static int SeaweedFSStorageAPI_RemoveFile(struct Longtail_StorageAPI* storage_api, const char* path) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(path);

  CurlResponse r = HttpDelete(url, seaweed_storage_api->m_JWT);

  if (r.status_code >= 200 && r.status_code < 300) {
    return 0;
  }

  return r.status_code > 0 ? (int)r.status_code : EIO;
}

static int SeaweedFSStorageAPI_StartFind(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HIterator* out_iterator) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_iterator, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, path != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, out_iterator != 0, return EINVAL);

  // Not implemented for SeaweedFS
  return ENOENT;
}

static int SeaweedFSStorageAPI_FindNext(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HIterator iterator) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(iterator, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_VALIDATE_INPUT(ctx, iterator != 0, return EINVAL);

  // Not implemented for SeaweedFS
  return ENOENT;
}

static void SeaweedFSStorageAPI_CloseFind(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HIterator iterator) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(iterator, "%s")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return);
  LONGTAIL_VALIDATE_INPUT(ctx, iterator != 0, return);
}

static int SeaweedFSStorageAPI_GetEntryProperties(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HIterator iterator,
    struct Longtail_StorageAPI_EntryProperties* out_properties) {
#if defined(LONGTAIL_ASSERTS)
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(iterator, "%s"),
      LONGTAIL_LOGFIELD(out_properties, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);
#else
  struct Longtail_LogContextFmt_Private* ctx = 0;
#endif  // defined(LONGTAIL_ASSERTS)

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, iterator != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, out_properties != 0, return EINVAL);

  // Not implemented for SeaweedFS
  return ENOENT;
}

static int SeaweedFSStorageAPI_LockFile(struct Longtail_StorageAPI* storage_api, const char* path, Longtail_StorageAPI_HLockFile* out_lock_file) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(path, "%s"),
      LONGTAIL_LOGFIELD(out_lock_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, path != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, out_lock_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;

  char* lock_path = (char*)Longtail_Alloc("SeaweedFSStorageAPI_LockFile", strlen(path) + 5 + 1);
  if (!lock_path) {
    return ENOMEM;
  }

  strcpy(lock_path, path);
  strcat(lock_path, ".lock");

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "SeaweedFSStorageAPI_LockFile: %s", lock_path);

  // Wait for lock file to not exist
  while (SeaweedFSStorageAPI_IsFile(storage_api, lock_path)) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)Longtail_Alloc(
      "SeaweedFSStorageAPI_LockFile",
      sizeof(struct SeaweedFSStorageAPI_OpenFile));

  if (!open_file) {
    Longtail_Free(lock_path);
    return ENOMEM;
  }

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(lock_path);

  // Create lock file with empty content
  CurlResponse r = HttpPostMultipart(url, seaweed_storage_api->m_JWT, "", 0, "lock");

  if (r.status_code >= 200 && r.status_code < 300) {
    memset(open_file, 0, sizeof(struct SeaweedFSStorageAPI_OpenFile));
    open_file->m_Path = lock_path;
    *out_lock_file = (Longtail_StorageAPI_HLockFile)open_file;
    return 0;
  } else {
    Longtail_Free(lock_path);
    Longtail_Free(open_file);
    return r.status_code > 0 ? (int)r.status_code : EIO;
  }
}

static int SeaweedFSStorageAPI_UnlockFile(struct Longtail_StorageAPI* storage_api, Longtail_StorageAPI_HLockFile lock_file) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(lock_file, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_FATAL_ASSERT(ctx, storage_api != 0, return EINVAL);
  LONGTAIL_FATAL_ASSERT(ctx, lock_file != 0, return EINVAL);

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;
  SeaweedFSStorageAPI_OpenFile* open_file = (struct SeaweedFSStorageAPI_OpenFile*)lock_file;

  std::string url = std::string(seaweed_storage_api->m_URL) + std::string(open_file->m_Path);

  LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_DEBUG, "SeaweedFSStorageAPI_UnlockFile: %s", url.c_str());

  CurlResponse r = HttpDelete(url, seaweed_storage_api->m_JWT);

  Longtail_Free(open_file->m_Path);
  Longtail_Free(open_file);

  // 404 is OK - lock file might have been deleted already
  return (r.status_code == 404 || (r.status_code >= 200 && r.status_code < 300)) ? 0 : (r.status_code > 0 ? (int)r.status_code : EIO);
}

static char* SeaweedFSStorageAPI_GetParentPath(
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

static int SeaweedFSStorageAPI_MapFile(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HOpenFile f,
    uint64_t offset,
    uint64_t length,
    Longtail_StorageAPI_HFileMap* out_file_map,
    const void** out_data_ptr) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(f, "%p"),
      LONGTAIL_LOGFIELD(offset, "%" PRIu64),
      LONGTAIL_LOGFIELD(length, "%" PRIu64),
      LONGTAIL_LOGFIELD(out_file_map, "%p"),
      LONGTAIL_LOGFIELD(out_data_ptr, "%p"),
      MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_OFF);

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, f != 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, length > 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, out_file_map != 0, return EINVAL)
  LONGTAIL_VALIDATE_INPUT(ctx, out_data_ptr != 0, return EINVAL)

  // Not supported for remote storage
  return ENOTSUP;
}

static void SeaweedFSStorageAPI_UnmapFile(
    struct Longtail_StorageAPI* storage_api,
    Longtail_StorageAPI_HFileMap m) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(storage_api, "%p"),
      LONGTAIL_LOGFIELD(m, "%p"),
      MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_OFF);

  LONGTAIL_VALIDATE_INPUT(ctx, storage_api != 0, return)
  LONGTAIL_VALIDATE_INPUT(ctx, m != 0, return)

  // Not supported for remote storage
}

static int SeaweedFSStorageAPI_Init(
    void* mem,
    struct Longtail_StorageAPI** out_storage_api) {
  MAKE_LOG_CONTEXT_FIELDS(ctx)
  LONGTAIL_LOGFIELD(mem, "%p"),
      LONGTAIL_LOGFIELD(out_storage_api, "%p")
          MAKE_LOG_CONTEXT_WITH_FIELDS(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG);

  LONGTAIL_VALIDATE_INPUT(ctx, mem != 0, return 0);
  struct Longtail_StorageAPI* api = Longtail_MakeStorageAPI(
      mem,
      SeaweedFSStorageAPI_Dispose,
      SeaweedFSStorageAPI_OpenReadFile,
      SeaweedFSStorageAPI_GetSize,
      SeaweedFSStorageAPI_Read,
      SeaweedFSStorageAPI_OpenWriteFile,
      SeaweedFSStorageAPI_Write,
      SeaweedFSStorageAPI_SetSize,
      SeaweedFSStorageAPI_SetPermissions,
      SeaweedFSStorageAPI_GetPermissions,
      SeaweedFSStorageAPI_CloseFile,
      SeaweedFSStorageAPI_CreateDir,
      SeaweedFSStorageAPI_RenameFile,
      SeaweedFSStorageAPI_ConcatPath,
      SeaweedFSStorageAPI_IsDir,
      SeaweedFSStorageAPI_IsFile,
      SeaweedFSStorageAPI_RemoveDir,
      SeaweedFSStorageAPI_RemoveFile,
      SeaweedFSStorageAPI_StartFind,
      SeaweedFSStorageAPI_FindNext,
      SeaweedFSStorageAPI_CloseFind,
      SeaweedFSStorageAPI_GetEntryProperties,
      SeaweedFSStorageAPI_LockFile,
      SeaweedFSStorageAPI_UnlockFile,
      SeaweedFSStorageAPI_GetParentPath,
      SeaweedFSStorageAPI_MapFile,
      SeaweedFSStorageAPI_UnmapFile);
  *out_storage_api = api;
  return 0;
}

struct Longtail_StorageAPI* CreateSeaweedFSStorageAPI(const char* url, const char* jwt) {
  MAKE_LOG_CONTEXT(ctx, 0, LONGTAIL_LOG_LEVEL_DEBUG)

  void* mem = (struct FSStorageAPI*)Longtail_Alloc("SeaweedFSStorageAPI", sizeof(struct SeaweedFSStorageAPI));
  if (!mem) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "Longtail_Alloc() failed with %d", ENOMEM)
    return 0;
  }
  struct Longtail_StorageAPI* storage_api;
  int err = SeaweedFSStorageAPI_Init(mem, &storage_api);
  if (err) {
    LONGTAIL_LOG(ctx, LONGTAIL_LOG_LEVEL_ERROR, "SeaweedFSStorageAPI_Init() failed with %d", err)
    return 0;
  }

  struct SeaweedFSStorageAPI* seaweed_storage_api = (SeaweedFSStorageAPI*)storage_api;
  seaweed_storage_api->m_URL = strdup(url);
  seaweed_storage_api->m_JWT = strdup(jwt);
  seaweed_storage_api->m_NumAddedBlocks = 0;

  return storage_api;
}
