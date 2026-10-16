#include "tracking-storage.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/stat.h>
#endif

namespace {

struct Written {
  uint64_t size = 0;
  int64_t mtime_sec = 0;
  int64_t mtime_nsec = 0;
  int has_stat = 0;
  int has_permissions = 0;
  uint16_t permissions = 0;
};

struct TrackingStorageAPI {
  struct Longtail_StorageAPI m_API;  // must come first
  struct Longtail_StorageAPI* m_Inner;
  std::mutex* m_Lock;
  std::unordered_map<Longtail_StorageAPI_HOpenFile, std::string>* m_OpenWrites;
  std::map<std::string, Written>* m_Written;
};

TrackingStorageAPI* Self(struct Longtail_StorageAPI* api) {
  return reinterpret_cast<TrackingStorageAPI*>(api);
}

/**
 * The file's size and mtime as Node's fs.stat reports them (libuv's
 * conversion), so the daemon's comparison of a later stat with these is exact.
 */
bool StatFile(const std::string& path, Written* out) {
#ifdef _WIN32
  int wide_len = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  if (wide_len <= 0) {
    return false;
  }
  std::wstring wide(static_cast<size_t>(wide_len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &wide[0], wide_len);
  wide.resize(static_cast<size_t>(wide_len) - 1);
  for (wchar_t& c : wide) {
    if (c == L'/') c = L'\\';
  }
  if (wide.rfind(L"\\\\?\\", 0) != 0 && wide.size() > 2 && wide[1] == L':') {
    wide = L"\\\\?\\" + wide;
  }
  WIN32_FILE_ATTRIBUTE_DATA data;
  if (!GetFileAttributesExW(wide.c_str(), GetFileExInfoStandard, &data)) {
    return false;
  }
  ULARGE_INTEGER t;
  t.LowPart = data.ftLastWriteTime.dwLowDateTime;
  t.HighPart = data.ftLastWriteTime.dwHighDateTime;
  const uint64_t since_epoch = t.QuadPart - 116444736000000000ULL;
  out->mtime_sec = static_cast<int64_t>(since_epoch / 10000000ULL);
  out->mtime_nsec = static_cast<int64_t>((since_epoch % 10000000ULL) * 100);
  out->size = (static_cast<uint64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
#else
  struct stat st;
  if (stat(path.c_str(), &st) != 0) {
    return false;
  }
#ifdef __APPLE__
  out->mtime_sec = st.st_mtimespec.tv_sec;
  out->mtime_nsec = st.st_mtimespec.tv_nsec;
#else
  out->mtime_sec = st.st_mtim.tv_sec;
  out->mtime_nsec = st.st_mtim.tv_nsec;
#endif
  out->size = static_cast<uint64_t>(st.st_size);
#endif
  out->has_stat = 1;
  return true;
}

void Dispose(struct Longtail_API* api) {
  TrackingStorageAPI* self = reinterpret_cast<TrackingStorageAPI*>(api);
  SAFE_DISPOSE_API(self->m_Inner);
  delete self->m_Lock;
  delete self->m_OpenWrites;
  delete self->m_Written;
  Longtail_Free(self);
}

int OpenReadFile(struct Longtail_StorageAPI* a, const char* path, Longtail_StorageAPI_HOpenFile* f) {
  return Self(a)->m_Inner->OpenReadFile(Self(a)->m_Inner, path, f);
}
int GetSize(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HOpenFile f, uint64_t* s) {
  return Self(a)->m_Inner->GetSize(Self(a)->m_Inner, f, s);
}
int Read(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HOpenFile f, uint64_t o, uint64_t l, void* out) {
  return Self(a)->m_Inner->Read(Self(a)->m_Inner, f, o, l, out);
}
int OpenWriteFile(struct Longtail_StorageAPI* a, const char* path, uint64_t initial_size, Longtail_StorageAPI_HOpenFile* f) {
  TrackingStorageAPI* self = Self(a);
  int err = self->m_Inner->OpenWriteFile(self->m_Inner, path, initial_size, f);
  if (err == 0) {
    std::lock_guard<std::mutex> lock(*self->m_Lock);
    (*self->m_OpenWrites)[*f] = path;
  }
  return err;
}
int Write(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HOpenFile f, uint64_t o, uint64_t l, const void* in) {
  return Self(a)->m_Inner->Write(Self(a)->m_Inner, f, o, l, in);
}
int SetSize(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HOpenFile f, uint64_t l) {
  return Self(a)->m_Inner->SetSize(Self(a)->m_Inner, f, l);
}
int SetPermissions(struct Longtail_StorageAPI* a, const char* path, uint16_t permissions) {
  TrackingStorageAPI* self = Self(a);
  int err = self->m_Inner->SetPermissions(self->m_Inner, path, permissions);
  if (err == 0) {
    std::lock_guard<std::mutex> lock(*self->m_Lock);
    auto it = self->m_Written->find(path);
    if (it != self->m_Written->end()) {
      it->second.has_permissions = 1;
      it->second.permissions = permissions;
    }
  }
  return err;
}
int GetPermissions(struct Longtail_StorageAPI* a, const char* path, uint16_t* out) {
  return Self(a)->m_Inner->GetPermissions(Self(a)->m_Inner, path, out);
}
void CloseFile(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HOpenFile f) {
  TrackingStorageAPI* self = Self(a);
  std::string path;
  {
    std::lock_guard<std::mutex> lock(*self->m_Lock);
    auto it = self->m_OpenWrites->find(f);
    if (it != self->m_OpenWrites->end()) {
      path = it->second;
      self->m_OpenWrites->erase(it);
    }
  }
  self->m_Inner->CloseFile(self->m_Inner, f);
  if (!path.empty()) {
    Written w;
    if (StatFile(path, &w)) {
      std::lock_guard<std::mutex> lock(*self->m_Lock);
      // Rewritten (a path whole indexes write twice): the last write wins.
      (*self->m_Written)[path] = w;
    }
  }
}
int CreateDir(struct Longtail_StorageAPI* a, const char* p) { return Self(a)->m_Inner->CreateDir(Self(a)->m_Inner, p); }
int RenameFile(struct Longtail_StorageAPI* a, const char* s, const char* t) { return Self(a)->m_Inner->RenameFile(Self(a)->m_Inner, s, t); }
char* ConcatPath(struct Longtail_StorageAPI* a, const char* r, const char* s) { return Self(a)->m_Inner->ConcatPath(Self(a)->m_Inner, r, s); }
int IsDir(struct Longtail_StorageAPI* a, const char* p) { return Self(a)->m_Inner->IsDir(Self(a)->m_Inner, p); }
int IsFile(struct Longtail_StorageAPI* a, const char* p) { return Self(a)->m_Inner->IsFile(Self(a)->m_Inner, p); }
int RemoveDir(struct Longtail_StorageAPI* a, const char* p) { return Self(a)->m_Inner->RemoveDir(Self(a)->m_Inner, p); }
int RemoveFile(struct Longtail_StorageAPI* a, const char* p) { return Self(a)->m_Inner->RemoveFile(Self(a)->m_Inner, p); }
int StartFind(struct Longtail_StorageAPI* a, const char* p, Longtail_StorageAPI_HIterator* i) { return Self(a)->m_Inner->StartFind(Self(a)->m_Inner, p, i); }
int FindNext(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HIterator i) { return Self(a)->m_Inner->FindNext(Self(a)->m_Inner, i); }
void CloseFind(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HIterator i) { Self(a)->m_Inner->CloseFind(Self(a)->m_Inner, i); }
int GetEntryProperties(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HIterator i, struct Longtail_StorageAPI_EntryProperties* p) {
  return Self(a)->m_Inner->GetEntryProperties(Self(a)->m_Inner, i, p);
}
int LockFile(struct Longtail_StorageAPI* a, const char* p, Longtail_StorageAPI_HLockFile* l) { return Self(a)->m_Inner->LockFile(Self(a)->m_Inner, p, l); }
int UnlockFile(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HLockFile l) { return Self(a)->m_Inner->UnlockFile(Self(a)->m_Inner, l); }
char* GetParentPath(struct Longtail_StorageAPI* a, const char* p) { return Self(a)->m_Inner->GetParentPath(Self(a)->m_Inner, p); }
int MapFile(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HOpenFile f, uint64_t o, uint64_t l, Longtail_StorageAPI_HFileMap* m, const void** d) {
  return Self(a)->m_Inner->MapFile(Self(a)->m_Inner, f, o, l, m, d);
}
void UnmapFile(struct Longtail_StorageAPI* a, Longtail_StorageAPI_HFileMap m) { Self(a)->m_Inner->UnMapFile(Self(a)->m_Inner, m); }

std::string Normalize(std::string p) {
  for (char& c : p) {
    if (c == '\\') c = '/';
  }
  if (p.rfind("//?/", 0) == 0) {
    p = p.substr(4);
  }
  return p;
}

}  // namespace

struct Longtail_StorageAPI* CreateTrackingStorageAPI(struct Longtail_StorageAPI* inner) {
  if (!inner) {
    return nullptr;
  }
  void* mem = Longtail_Alloc("TrackingStorageAPI", sizeof(TrackingStorageAPI));
  if (!mem) {
    SAFE_DISPOSE_API(inner);
    return nullptr;
  }
  struct Longtail_StorageAPI* api = Longtail_MakeStorageAPI(
      mem, Dispose, OpenReadFile, GetSize, Read, OpenWriteFile, Write, SetSize,
      SetPermissions, GetPermissions, CloseFile, CreateDir, RenameFile,
      ConcatPath, IsDir, IsFile, RemoveDir, RemoveFile, StartFind, FindNext,
      CloseFind, GetEntryProperties, LockFile, UnlockFile, GetParentPath,
      MapFile, UnmapFile);
  TrackingStorageAPI* self = reinterpret_cast<TrackingStorageAPI*>(api);
  self->m_Inner = inner;
  self->m_Lock = new std::mutex();
  self->m_OpenWrites =
      new std::unordered_map<Longtail_StorageAPI_HOpenFile, std::string>();
  self->m_Written = new std::map<std::string, Written>();
  return api;
}

int WriteTrackedFiles(
    struct Longtail_StorageAPI* tracking_api,
    const char* root,
    const char* out_path) {
  if (!tracking_api || !root || !out_path) {
    return EINVAL;
  }
  TrackingStorageAPI* self = Self(tracking_api);
  std::string prefix = Normalize(root);
  while (!prefix.empty() && prefix.back() == '/') {
    prefix.pop_back();
  }
  prefix += "/";

#ifdef _WIN32
  int wide_len = MultiByteToWideChar(CP_UTF8, 0, out_path, -1, nullptr, 0);
  std::wstring wide_out(static_cast<size_t>(wide_len > 0 ? wide_len : 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, out_path, -1, &wide_out[0], wide_len);
  FILE* out = _wfopen(wide_out.c_str(), L"wb");
#else
  FILE* out = std::fopen(out_path, "wb");
#endif
  if (!out) {
    return errno ? errno : EIO;
  }
  std::lock_guard<std::mutex> lock(*self->m_Lock);
  for (const auto& [full, w] : *self->m_Written) {
    std::string rel = Normalize(full);
    if (rel.size() <= prefix.size() || rel.compare(0, prefix.size(), prefix) != 0) {
      continue;
    }
    rel = rel.substr(prefix.size());
    if (w.has_permissions) {
      std::fprintf(out, "%s\t%llu\t%lld\t%lld\t%o\n", rel.c_str(),
                   static_cast<unsigned long long>(w.size),
                   static_cast<long long>(w.mtime_sec),
                   static_cast<long long>(w.mtime_nsec),
                   static_cast<unsigned>(w.permissions));
    } else {
      std::fprintf(out, "%s\t%llu\t%lld\t%lld\t-\n", rel.c_str(),
                   static_cast<unsigned long long>(w.size),
                   static_cast<long long>(w.mtime_sec),
                   static_cast<long long>(w.mtime_nsec));
    }
  }
  return std::fclose(out) == 0 ? 0 : EIO;
}

int WritePullRecord(struct Longtail_StorageAPI* tracking_api, const char* root) {
  if (!root) {
    return EINVAL;
  }
  const std::string out = std::string(root) + "/.checkpoint/pull-written.tsv";
  return WriteTrackedFiles(tracking_api, root, out.c_str());
}
