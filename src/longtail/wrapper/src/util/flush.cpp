#include "flush.h"

void SyncFlush_OnComplete(struct Longtail_AsyncFlushAPI* async_complete_api, int err) {
  struct SyncFlush* api = (struct SyncFlush*)async_complete_api;
  api->m_Err = err;
  Longtail_PostSema(api->m_NotifySema, 1);
}

void SyncFlush_Wait(struct SyncFlush* sync_flush) {
  Longtail_WaitSema(sync_flush->m_NotifySema, LONGTAIL_TIMEOUT_INFINITE);
}

void SyncFlush_Dispose(struct Longtail_API* longtail_api) {
  struct SyncFlush* api = (struct SyncFlush*)longtail_api;
  Longtail_DeleteSema(api->m_NotifySema);
  Longtail_Free(api->m_NotifySema);
}

int SyncFlush_Init(struct SyncFlush* sync_flush) {
  sync_flush->m_Err = EINVAL;
  sync_flush->m_API.m_API.Dispose = SyncFlush_Dispose;
  sync_flush->m_API.OnComplete = SyncFlush_OnComplete;
  return Longtail_CreateSema(Longtail_Alloc(0, Longtail_GetSemaSize()), 0, &sync_flush->m_NotifySema);
}
