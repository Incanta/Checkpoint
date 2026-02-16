// Node.js N-API addon that statically links the LongtailWrapper C++ code
// and the Longtail C library. No external DLLs needed at runtime.

#include <napi.h>

#include <cstring>
#include <deque>
#include <string>
#include <vector>

// Include the wrapper's main header — gives us struct definitions
// (WrapperAsyncHandle, ReadFileAsyncHandle, Checkpoint::Modification)
// plus DLL_EXPORT macro and utility function declarations.
#include "main.h"

// --------------------------------------------------------------------------
// Forward declarations for DLL_EXPORT functions defined in the wrapper
// .cpp files (compiled directly into this addon).
// These are extern "C" because DLL_EXPORT expands to extern "C" [dllexport].
// --------------------------------------------------------------------------

extern "C" {
WrapperAsyncHandle* SubmitAsync(
    const char* BranchName,
    const char* Message,
    uint32_t TargetChunkSize,
    uint32_t TargetBlockSize,
    uint32_t MaxChunksPerBlock,
    uint32_t MinBlockUsagePercent,
    const char* HashingAlgo,
    const char* CompressionAlgo,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* BackendUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    const char* API_JWT,
    bool KeepCheckedOut,
    const char* WorkspaceId,
    uint32_t NumModifications,
    const Checkpoint::Modification* Modifications,
    int LogLevel);

void FreeHandle(WrapperAsyncHandle* handle);

WrapperAsyncHandle* MergeAsync(
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    void* additional_store_index_buffer,
    size_t additional_store_index_size,
    int LogLevel);

WrapperAsyncHandle* PullAsync(
    const char* VersionIndex,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    int LogLevel);

ReadFileAsyncHandle* ReadFileFromVersionAsync(
    const char* FilePath,
    const char* VersionIndexName,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    int LogLevel);

void FreeReadFileHandle(ReadFileAsyncHandle* handle);
void* GetReadFileData(ReadFileAsyncHandle* handle);
uint64_t GetReadFileSize(ReadFileAsyncHandle* handle);
}

// --------------------------------------------------------------------------
// HandleContext: holds native handle + keeps string/modification data alive
// until the async operation completes and freeHandle is called from JS.
// --------------------------------------------------------------------------

struct HandleContext {
  void* nativeHandle = nullptr;
  bool isReadFileHandle = false;
  bool freed = false;

  // String storage — keeps c_str() pointers valid for the lifetime of the
  // detached thread inside the wrapper's *Async functions.
  // Uses deque instead of vector because deque::push_back does NOT
  // invalidate references to existing elements (vector would reallocate
  // and invalidate all prior c_str() pointers).
  std::deque<std::string> strings;

  // Modification structs for SubmitAsync
  std::vector<Checkpoint::Modification> modifications;

  // Buffer data for MergeAsync
  std::vector<uint8_t> bufferData;

  void Free() {
    if (freed || !nativeHandle) return;
    freed = true;
    if (isReadFileHandle) {
      ::FreeReadFileHandle(static_cast<ReadFileAsyncHandle*>(nativeHandle));
    } else {
      ::FreeHandle(static_cast<WrapperAsyncHandle*>(nativeHandle));
    }
    nativeHandle = nullptr;
  }

  ~HandleContext() {
    Free();
  }
};

// GC weak-ref clean-up so native memory is freed if JS drops the handle.
static void ContextCleanup(Napi::Env /*env*/, HandleContext* ctx) {
  delete ctx;
}

// --------------------------------------------------------------------------
// Helper: add a string to context, return stable c_str() pointer
// --------------------------------------------------------------------------
static const char* StoreString(HandleContext* ctx, const std::string& s) {
  ctx->strings.push_back(s);
  return ctx->strings.back().c_str();
}

// --------------------------------------------------------------------------
// submitAsync(options: object): External<HandleContext>
// --------------------------------------------------------------------------
static Napi::Value NapiSubmitAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  auto* ctx = new HandleContext();

  const char* branchName = StoreString(ctx, opts.Get("branchName").As<Napi::String>().Utf8Value());
  const char* message = StoreString(ctx, opts.Get("message").As<Napi::String>().Utf8Value());
  uint32_t targetChunkSize = opts.Get("targetChunkSize").As<Napi::Number>().Uint32Value();
  uint32_t targetBlockSize = opts.Get("targetBlockSize").As<Napi::Number>().Uint32Value();
  uint32_t maxChunksPerBlock = opts.Get("maxChunksPerBlock").As<Napi::Number>().Uint32Value();
  uint32_t minBlockUsagePercent = opts.Get("minBlockUsagePercent").As<Napi::Number>().Uint32Value();
  const char* hashingAlgo = StoreString(ctx, opts.Get("hashingAlgo").As<Napi::String>().Utf8Value());
  const char* compressionAlgo = StoreString(ctx, opts.Get("compressionAlgo").As<Napi::String>().Utf8Value());
  bool enableMmapIndexing = opts.Get("enableMmapIndexing").As<Napi::Boolean>().Value();
  bool enableMmapBlockStore = opts.Get("enableMmapBlockStore").As<Napi::Boolean>().Value();
  const char* localRootPath = StoreString(ctx, opts.Get("localRootPath").As<Napi::String>().Utf8Value());
  const char* remoteBasePath = StoreString(ctx, opts.Get("remoteBasePath").As<Napi::String>().Utf8Value());
  const char* filerUrl = StoreString(ctx, opts.Get("filerUrl").As<Napi::String>().Utf8Value());
  const char* backendUrl = StoreString(ctx, opts.Get("backendUrl").As<Napi::String>().Utf8Value());
  const char* jwt = StoreString(ctx, opts.Get("jwt").As<Napi::String>().Utf8Value());
  uint64_t jwtExpirationMs = static_cast<uint64_t>(opts.Get("jwtExpirationMs").As<Napi::Number>().Int64Value());
  const char* apiJwt = StoreString(ctx, opts.Get("apiJwt").As<Napi::String>().Utf8Value());
  bool keepCheckedOut = opts.Get("keepCheckedOut").As<Napi::Boolean>().Value();
  const char* workspaceId = StoreString(ctx, opts.Get("workspaceId").As<Napi::String>().Utf8Value());
  int logLevel = opts.Get("logLevel").As<Napi::Number>().Int32Value();

  // Build modifications array
  Napi::Array modsArray = opts.Get("modifications").As<Napi::Array>();
  uint32_t numMods = modsArray.Length();

  ctx->modifications.resize(numMods);
  for (uint32_t i = 0; i < numMods; ++i) {
    Napi::Object mod = modsArray.Get(i).As<Napi::Object>();

    ctx->modifications[i].IsDelete = mod.Get("delete").As<Napi::Boolean>().Value();
    ctx->modifications[i].Path = StoreString(ctx, mod.Get("path").As<Napi::String>().Utf8Value());

    Napi::Value oldPathVal = mod.Get("oldPath");
    if (oldPathVal.IsString()) {
      ctx->modifications[i].OldPath = StoreString(ctx, oldPathVal.As<Napi::String>().Utf8Value());
    } else {
      ctx->modifications[i].OldPath = nullptr;
    }
  }

  WrapperAsyncHandle* handle = ::SubmitAsync(
      branchName, message,
      targetChunkSize, targetBlockSize, maxChunksPerBlock, minBlockUsagePercent,
      hashingAlgo, compressionAlgo,
      enableMmapIndexing, enableMmapBlockStore,
      localRootPath, remoteBasePath, filerUrl, backendUrl,
      jwt, jwtExpirationMs, apiJwt,
      keepCheckedOut, workspaceId,
      numMods, ctx->modifications.data(),
      logLevel);

  if (!handle) {
    delete ctx;
    Napi::Error::New(env, "SubmitAsync returned null handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ctx->nativeHandle = handle;
  ctx->isReadFileHandle = false;

  return Napi::External<HandleContext>::New(env, ctx, ContextCleanup);
}

// --------------------------------------------------------------------------
// pullAsync(options: object): External<HandleContext>
// --------------------------------------------------------------------------
static Napi::Value NapiPullAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  auto* ctx = new HandleContext();

  const char* versionIndex = StoreString(ctx, opts.Get("versionIndex").As<Napi::String>().Utf8Value());
  bool enableMmapIndexing = opts.Get("enableMmapIndexing").As<Napi::Boolean>().Value();
  bool enableMmapBlockStore = opts.Get("enableMmapBlockStore").As<Napi::Boolean>().Value();
  const char* localRootPath = StoreString(ctx, opts.Get("localRootPath").As<Napi::String>().Utf8Value());
  const char* remoteBasePath = StoreString(ctx, opts.Get("remoteBasePath").As<Napi::String>().Utf8Value());
  const char* filerUrl = StoreString(ctx, opts.Get("filerUrl").As<Napi::String>().Utf8Value());
  const char* jwt = StoreString(ctx, opts.Get("jwt").As<Napi::String>().Utf8Value());
  uint64_t jwtExpirationMs = static_cast<uint64_t>(opts.Get("jwtExpirationMs").As<Napi::Number>().Int64Value());
  int logLevel = opts.Get("logLevel").As<Napi::Number>().Int32Value();

  WrapperAsyncHandle* handle = ::PullAsync(
      versionIndex,
      enableMmapIndexing, enableMmapBlockStore,
      localRootPath, remoteBasePath, filerUrl, jwt,
      jwtExpirationMs, logLevel);

  if (!handle) {
    delete ctx;
    Napi::Error::New(env, "PullAsync returned null handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ctx->nativeHandle = handle;
  ctx->isReadFileHandle = false;

  return Napi::External<HandleContext>::New(env, ctx, ContextCleanup);
}

// --------------------------------------------------------------------------
// mergeAsync(options: object): External<HandleContext>
// --------------------------------------------------------------------------
static Napi::Value NapiMergeAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  auto* ctx = new HandleContext();

  const char* remoteBasePath = StoreString(ctx, opts.Get("remoteBasePath").As<Napi::String>().Utf8Value());
  const char* filerUrl = StoreString(ctx, opts.Get("filerUrl").As<Napi::String>().Utf8Value());
  const char* jwt = StoreString(ctx, opts.Get("jwt").As<Napi::String>().Utf8Value());
  int logLevel = opts.Get("logLevel").As<Napi::Number>().Int32Value();

  // Copy the store index buffer so it stays alive for the async operation
  Napi::Buffer<uint8_t> storeIndexBuf = opts.Get("storeIndexBuffer").As<Napi::Buffer<uint8_t>>();
  ctx->bufferData.assign(storeIndexBuf.Data(), storeIndexBuf.Data() + storeIndexBuf.Length());

  WrapperAsyncHandle* handle = ::MergeAsync(
      remoteBasePath, filerUrl, jwt,
      ctx->bufferData.data(),
      ctx->bufferData.size(),
      logLevel);

  if (!handle) {
    delete ctx;
    Napi::Error::New(env, "MergeAsync returned null handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ctx->nativeHandle = handle;
  ctx->isReadFileHandle = false;

  return Napi::External<HandleContext>::New(env, ctx, ContextCleanup);
}

// --------------------------------------------------------------------------
// readFileFromVersionAsync(options: object): External<HandleContext>
// --------------------------------------------------------------------------
static Napi::Value NapiReadFileFromVersionAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  auto* ctx = new HandleContext();

  const char* filePath = StoreString(ctx, opts.Get("filePath").As<Napi::String>().Utf8Value());
  const char* versionIndexName = StoreString(ctx, opts.Get("versionIndexName").As<Napi::String>().Utf8Value());
  const char* remoteBasePath = StoreString(ctx, opts.Get("remoteBasePath").As<Napi::String>().Utf8Value());
  const char* filerUrl = StoreString(ctx, opts.Get("filerUrl").As<Napi::String>().Utf8Value());
  const char* jwt = StoreString(ctx, opts.Get("jwt").As<Napi::String>().Utf8Value());
  uint64_t jwtExpirationMs = static_cast<uint64_t>(opts.Get("jwtExpirationMs").As<Napi::Number>().Int64Value());
  int logLevel = opts.Get("logLevel").As<Napi::Number>().Int32Value();

  ReadFileAsyncHandle* handle = ::ReadFileFromVersionAsync(
      filePath, versionIndexName, remoteBasePath,
      filerUrl, jwt, jwtExpirationMs, logLevel);

  if (!handle) {
    delete ctx;
    Napi::Error::New(env, "ReadFileFromVersionAsync returned null handle")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ctx->nativeHandle = handle;
  ctx->isReadFileHandle = true;

  return Napi::External<HandleContext>::New(env, ctx, ContextCleanup);
}

// --------------------------------------------------------------------------
// getHandleStatus(handle): { currentStep, changingStep, canceled, completed, error }
// --------------------------------------------------------------------------
static Napi::Value NapiGetHandleStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected handle (External) argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* ctx = info[0].As<Napi::External<HandleContext>>().Data();
  if (!ctx || !ctx->nativeHandle || ctx->freed) {
    Napi::Error::New(env, "Handle is invalid or already freed")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  WrapperAsyncHandle* handle;
  if (ctx->isReadFileHandle) {
    handle = &static_cast<ReadFileAsyncHandle*>(ctx->nativeHandle)->base;
  } else {
    handle = static_cast<WrapperAsyncHandle*>(ctx->nativeHandle);
  }

  Napi::Object result = Napi::Object::New(env);

  std::string step(handle->currentStep, strnlen(handle->currentStep, 256));
  result.Set("currentStep", Napi::String::New(env, step));
  result.Set("changingStep", Napi::Boolean::New(env, handle->changingStep != 0));
  result.Set("canceled", Napi::Boolean::New(env, handle->canceled != 0));
  result.Set("completed", Napi::Boolean::New(env, handle->completed != 0));
  result.Set("error", Napi::Number::New(env, handle->error));

  return result;
}

// --------------------------------------------------------------------------
// getHandleResult(handle): object | null
// --------------------------------------------------------------------------
static Napi::Value NapiGetHandleResult(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected handle (External) argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* ctx = info[0].As<Napi::External<HandleContext>>().Data();
  if (!ctx || !ctx->nativeHandle || ctx->freed) {
    Napi::Error::New(env, "Handle is invalid or already freed")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  WrapperAsyncHandle* handle;
  if (ctx->isReadFileHandle) {
    handle = &static_cast<ReadFileAsyncHandle*>(ctx->nativeHandle)->base;
  } else {
    handle = static_cast<WrapperAsyncHandle*>(ctx->nativeHandle);
  }

  std::string resultStr(handle->result, strnlen(handle->result, 2048));

  if (resultStr.empty() || resultStr[0] != '{') {
    return env.Null();
  }

  // Parse JSON via JS JSON.parse
  Napi::Object json = env.Global().Get("JSON").As<Napi::Object>();
  Napi::Function parse = json.Get("parse").As<Napi::Function>();
  return parse.Call(json, {Napi::String::New(env, resultStr)});
}

// --------------------------------------------------------------------------
// cancelHandle(handle): void
// --------------------------------------------------------------------------
static Napi::Value NapiCancelHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected handle (External) argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* ctx = info[0].As<Napi::External<HandleContext>>().Data();
  if (!ctx || !ctx->nativeHandle || ctx->freed) {
    return env.Undefined();
  }

  WrapperAsyncHandle* handle;
  if (ctx->isReadFileHandle) {
    handle = &static_cast<ReadFileAsyncHandle*>(ctx->nativeHandle)->base;
  } else {
    handle = static_cast<WrapperAsyncHandle*>(ctx->nativeHandle);
  }

  handle->canceled = 1;

  return env.Undefined();
}

// --------------------------------------------------------------------------
// freeHandle(handle): void
// --------------------------------------------------------------------------
static Napi::Value NapiFreeHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected handle (External) argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* ctx = info[0].As<Napi::External<HandleContext>>().Data();
  if (ctx) {
    ctx->Free();
  }

  return env.Undefined();
}

// --------------------------------------------------------------------------
// getReadFileData(handle): Buffer
// --------------------------------------------------------------------------
static Napi::Value NapiGetReadFileData(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected handle (External) argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* ctx = info[0].As<Napi::External<HandleContext>>().Data();
  if (!ctx || !ctx->nativeHandle || ctx->freed || !ctx->isReadFileHandle) {
    Napi::Error::New(env, "Handle is invalid, freed, or not a read-file handle")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* rfHandle = static_cast<ReadFileAsyncHandle*>(ctx->nativeHandle);

  void* data = ::GetReadFileData(rfHandle);
  uint64_t size = ::GetReadFileSize(rfHandle);

  if (!data || size == 0) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }

  // Copy data into a new Node.js Buffer (wrapper frees the original on FreeReadFileHandle)
  return Napi::Buffer<uint8_t>::Copy(env, static_cast<uint8_t*>(data), static_cast<size_t>(size));
}

// --------------------------------------------------------------------------
// getReadFileSize(handle): number
// --------------------------------------------------------------------------
static Napi::Value NapiGetReadFileSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsExternal()) {
    Napi::TypeError::New(env, "Expected handle (External) argument")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* ctx = info[0].As<Napi::External<HandleContext>>().Data();
  if (!ctx || !ctx->nativeHandle || ctx->freed || !ctx->isReadFileHandle) {
    return Napi::Number::New(env, 0);
  }

  auto* rfHandle = static_cast<ReadFileAsyncHandle*>(ctx->nativeHandle);
  uint64_t size = ::GetReadFileSize(rfHandle);

  return Napi::Number::New(env, static_cast<double>(size));
}

// --------------------------------------------------------------------------
// freeReadFileHandle(handle): void — alias for freeHandle
// --------------------------------------------------------------------------
static Napi::Value NapiFreeReadFileHandle(const Napi::CallbackInfo& info) {
  return NapiFreeHandle(info);
}

// --------------------------------------------------------------------------
// Module initialization
// --------------------------------------------------------------------------
static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("submitAsync", Napi::Function::New(env, NapiSubmitAsync));
  exports.Set("pullAsync", Napi::Function::New(env, NapiPullAsync));
  exports.Set("mergeAsync", Napi::Function::New(env, NapiMergeAsync));
  exports.Set("readFileFromVersionAsync", Napi::Function::New(env, NapiReadFileFromVersionAsync));
  exports.Set("getHandleStatus", Napi::Function::New(env, NapiGetHandleStatus));
  exports.Set("getHandleResult", Napi::Function::New(env, NapiGetHandleResult));
  exports.Set("cancelHandle", Napi::Function::New(env, NapiCancelHandle));
  exports.Set("freeHandle", Napi::Function::New(env, NapiFreeHandle));
  exports.Set("getReadFileData", Napi::Function::New(env, NapiGetReadFileData));
  exports.Set("getReadFileSize", Napi::Function::New(env, NapiGetReadFileSize));
  exports.Set("freeReadFileHandle", Napi::Function::New(env, NapiFreeReadFileHandle));

  return exports;
}

NODE_API_MODULE(longtail_addon, Init)
