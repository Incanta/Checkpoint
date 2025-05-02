#pragma once

#include "../exposed/main.h"

struct AsyncGetExistingContentComplete {
  struct Longtail_AsyncGetExistingContentAPI m_API;
  HLongtail_Sema m_NotifySema;
  int m_Err;
  struct Longtail_StoreIndex* m_StoreIndex;
};

void AsyncGetExistingContentComplete_OnComplete(struct Longtail_AsyncGetExistingContentAPI* async_complete_api, struct Longtail_StoreIndex* store_index, int err);
void AsyncGetExistingContentComplete_Wait(struct AsyncGetExistingContentComplete* api);
void AsyncGetExistingContentComplete_Init(struct AsyncGetExistingContentComplete* api);
void AsyncGetExistingContentComplete_Dispose(struct AsyncGetExistingContentComplete* api);
int SyncGetExistingContent(struct Longtail_BlockStoreAPI* block_store, uint32_t chunk_count, const TLongtail_Hash* chunk_hashes, uint32_t min_block_usage_percent, struct Longtail_StoreIndex** out_store_index);
