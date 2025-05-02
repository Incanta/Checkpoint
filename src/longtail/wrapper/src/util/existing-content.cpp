#include "existing-content.h"

void AsyncGetExistingContentComplete_OnComplete(struct Longtail_AsyncGetExistingContentAPI* async_complete_api, struct Longtail_StoreIndex* store_index, int err) {
  struct AsyncGetExistingContentComplete* cb = (struct AsyncGetExistingContentComplete*)async_complete_api;
  cb->m_Err = err;
  cb->m_StoreIndex = store_index;
  Longtail_PostSema(cb->m_NotifySema, 1);
}

void AsyncGetExistingContentComplete_Wait(struct AsyncGetExistingContentComplete* api) {
  Longtail_WaitSema(api->m_NotifySema, LONGTAIL_TIMEOUT_INFINITE);
}

void AsyncGetExistingContentComplete_Init(struct AsyncGetExistingContentComplete* api) {
  api->m_Err = EINVAL;
  api->m_API.m_API.Dispose = 0;
  api->m_API.OnComplete = AsyncGetExistingContentComplete_OnComplete;
  api->m_StoreIndex = 0;
  Longtail_CreateSema(Longtail_Alloc(0, Longtail_GetSemaSize()), 0, &api->m_NotifySema);
}

void AsyncGetExistingContentComplete_Dispose(struct AsyncGetExistingContentComplete* api) {
  Longtail_DeleteSema(api->m_NotifySema);
  Longtail_Free(api->m_NotifySema);
}

int SyncGetExistingContent(struct Longtail_BlockStoreAPI* block_store, uint32_t chunk_count, const TLongtail_Hash* chunk_hashes, uint32_t min_block_usage_percent, struct Longtail_StoreIndex** out_store_index) {
  struct AsyncGetExistingContentComplete retarget_store_index_complete;
  AsyncGetExistingContentComplete_Init(&retarget_store_index_complete);
  int err = block_store->GetExistingContent(block_store, chunk_count, chunk_hashes, min_block_usage_percent, &retarget_store_index_complete.m_API);
  if (err) {
    return err;
  }
  AsyncGetExistingContentComplete_Wait(&retarget_store_index_complete);
  err = retarget_store_index_complete.m_Err;
  struct Longtail_StoreIndex* store_index = retarget_store_index_complete.m_StoreIndex;
  AsyncGetExistingContentComplete_Dispose(&retarget_store_index_complete);
  if (err) {
    return err;
  }
  *out_store_index = store_index;
  return 0;
}
