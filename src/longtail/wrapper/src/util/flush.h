#pragma once

#include "../exposed/main.h"

struct SyncFlush {
  struct Longtail_AsyncFlushAPI m_API;
  HLongtail_Sema m_NotifySema;
  int m_Err;
};

void SyncFlush_OnComplete(struct Longtail_AsyncFlushAPI* async_complete_api, int err);
void SyncFlush_Wait(struct SyncFlush* sync_flush);
void SyncFlush_Dispose(struct Longtail_API* longtail_api);
int SyncFlush_Init(struct SyncFlush* sync_flush);
