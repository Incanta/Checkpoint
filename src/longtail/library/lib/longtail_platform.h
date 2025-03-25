#pragma once

#include <stdint.h>
#include <stddef.h>

#include "../src/longtail.h"

#ifdef __cplusplus
extern "C" {
#endif

static const uint64_t LONGTAIL_TIMEOUT_INFINITE = ((uint64_t)-1);

LONGTAIL_EXPORT uint32_t    Longtail_GetCPUCount();
LONGTAIL_EXPORT void        Longtail_Sleep(uint64_t timeout_us);

LONGTAIL_EXPORT typedef int32_t volatile TLongtail_Atomic32;
LONGTAIL_EXPORT int32_t Longtail_AtomicAdd32(TLongtail_Atomic32* value, int32_t amount);

LONGTAIL_EXPORT typedef int64_t volatile TLongtail_Atomic64;
LONGTAIL_EXPORT int64_t Longtail_AtomicAdd64(TLongtail_Atomic64* value, int64_t amount);

LONGTAIL_EXPORT typedef struct Longtail_Thread* HLongtail_Thread;

LONGTAIL_EXPORT typedef int (*Longtail_ThreadFunc)(void* context_data);

LONGTAIL_EXPORT size_t      Longtail_GetThreadSize();
LONGTAIL_EXPORT int         Longtail_CreateThread(void* mem, Longtail_ThreadFunc thread_func, size_t stack_size, void* context_data, int priority, HLongtail_Thread* out_thread);
LONGTAIL_EXPORT int         Longtail_JoinThread(HLongtail_Thread thread, uint64_t timeout_us);
LONGTAIL_EXPORT void        Longtail_DeleteThread(HLongtail_Thread thread);
LONGTAIL_EXPORT uint64_t    Longtail_GetCurrentThreadId();

LONGTAIL_EXPORT typedef struct Longtail_Sema* HLongtail_Sema;
LONGTAIL_EXPORT size_t  Longtail_GetSemaSize();
LONGTAIL_EXPORT int     Longtail_CreateSema(void* mem, int initial_count, HLongtail_Sema* out_sema);
LONGTAIL_EXPORT int     Longtail_PostSema(HLongtail_Sema semaphore, unsigned int count);
LONGTAIL_EXPORT int     Longtail_WaitSema(HLongtail_Sema semaphore, uint64_t timeout_us);
LONGTAIL_EXPORT void    Longtail_DeleteSema(HLongtail_Sema semaphore);

LONGTAIL_EXPORT typedef struct Longtail_SpinLock* HLongtail_SpinLock;
LONGTAIL_EXPORT size_t  Longtail_GetSpinLockSize();
LONGTAIL_EXPORT int     Longtail_CreateSpinLock(void* mem, HLongtail_SpinLock* out_spin_lock);
LONGTAIL_EXPORT void    Longtail_DeleteSpinLock(HLongtail_SpinLock spin_lock);
LONGTAIL_EXPORT void    Longtail_LockSpinLock(HLongtail_SpinLock spin_lock);
LONGTAIL_EXPORT void    Longtail_UnlockSpinLock(HLongtail_SpinLock spin_lock);


LONGTAIL_EXPORT typedef struct Longtail_FSIterator_private* HLongtail_FSIterator;

LONGTAIL_EXPORT size_t Longtail_GetFSIteratorSize();

LONGTAIL_EXPORT int     Longtail_CreateDirectory(const char* path);
LONGTAIL_EXPORT int     Longtail_MoveFile(const char* source, const char* target);
LONGTAIL_EXPORT int     Longtail_IsDir(const char* path);
LONGTAIL_EXPORT int     Longtail_IsFile(const char* path);
LONGTAIL_EXPORT int     Longtail_RemoveDir(const char* path);
LONGTAIL_EXPORT int     Longtail_RemoveFile(const char* path);

LONGTAIL_EXPORT int         Longtail_StartFind(HLongtail_FSIterator fs_iterator, const char* path);
LONGTAIL_EXPORT int         Longtail_FindNext(HLongtail_FSIterator fs_iterator);
LONGTAIL_EXPORT void        Longtail_CloseFind(HLongtail_FSIterator fs_iterator);
LONGTAIL_EXPORT const char* Longtail_GetFileName(HLongtail_FSIterator fs_iterator);
LONGTAIL_EXPORT const char* Longtail_GetDirectoryName(HLongtail_FSIterator fs_iterator);
LONGTAIL_EXPORT int         Longtail_GetEntryProperties(HLongtail_FSIterator fs_iterator, uint64_t* out_size, uint16_t* out_permissions, int* out_is_dir);

LONGTAIL_EXPORT typedef struct Longtail_OpenFile_private* HLongtail_OpenFile;

LONGTAIL_EXPORT int     Longtail_OpenReadFile(const char* path, HLongtail_OpenFile* out_read_file);
LONGTAIL_EXPORT int     Longtail_OpenWriteFile(const char* path, uint64_t initial_size, HLongtail_OpenFile* out_write_file);
LONGTAIL_EXPORT int     Longtail_SetFileSize(HLongtail_OpenFile handle, uint64_t length);
LONGTAIL_EXPORT int     Longtail_SetFilePermissions(const char* path, uint16_t permissions);
LONGTAIL_EXPORT int     Longtail_GetFilePermissions(const char* path, uint16_t* out_permissions);
LONGTAIL_EXPORT int     Longtail_Read(HLongtail_OpenFile handle, uint64_t offset, uint64_t length, void* output);
LONGTAIL_EXPORT int     Longtail_Write(HLongtail_OpenFile handle, uint64_t offset, uint64_t length, const void* input);
LONGTAIL_EXPORT int     Longtail_GetFileSize(HLongtail_OpenFile handle, uint64_t* out_size);
LONGTAIL_EXPORT void    Longtail_CloseFile(HLongtail_OpenFile handle);
LONGTAIL_EXPORT char*   Longtail_ConcatPath(const char* folder, const char* file);
LONGTAIL_EXPORT char*   Longtail_GetParentPath(const char* path);

LONGTAIL_EXPORT typedef struct Longtail_FileMap_private* HLongtail_FileMap;
LONGTAIL_EXPORT int Longtail_MapFile(HLongtail_OpenFile handle, uint64_t offset, uint64_t length, HLongtail_FileMap* out_file_map, const void** out_data_ptr);
LONGTAIL_EXPORT void Longtail_UnmapFile(HLongtail_FileMap file_map);

LONGTAIL_EXPORT char* Longtail_GetTempFolder();

LONGTAIL_EXPORT uint64_t Longtail_GetProcessIdentity();

LONGTAIL_EXPORT typedef struct Longtail_FileLock_private* HLongtail_FileLock;
LONGTAIL_EXPORT size_t Longtail_GetFileLockSize();
LONGTAIL_EXPORT int Longtail_LockFile(void* mem, const char* path, HLongtail_FileLock* out_file_lock);
LONGTAIL_EXPORT int Longtail_UnlockFile(HLongtail_FileLock file_lock);

#ifdef __cplusplus
}
#endif
