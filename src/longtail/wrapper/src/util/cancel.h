#pragma once

#include "../exposed/main.h"

struct CheckpointCancelAPI {
  struct Longtail_CancelAPI m_API;
  struct WrapperAsyncHandle* m_Handle;
  CheckpointCancelAPI(struct WrapperAsyncHandle* handle)
      : m_Handle(handle) {
    Longtail_MakeCancelAPI(this,
                           Dispose,
                           CreateToken,
                           Cancel,
                           IsCancelled,
                           DisposeToken);
  }
  static void Dispose(struct Longtail_API* longtail_api) {
    struct CheckpointCancelAPI* api = (struct CheckpointCancelAPI*)longtail_api;
  }
  static int CreateToken(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken* out_token) {
    return 0;
  }
  static int Cancel(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken token) {
    struct CheckpointCancelAPI* api = (struct CheckpointCancelAPI*)cancel_api;
    api->m_Handle->canceled = 1;
    return 0;
  }
  static int IsCancelled(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken token) {
    struct CheckpointCancelAPI* api = (struct CheckpointCancelAPI*)cancel_api;
    return api->m_Handle->canceled ? 1 : 0;
  }
  static int DisposeToken(struct Longtail_CancelAPI* cancel_api, Longtail_CancelAPI_HCancelToken token) {
    return 0;
  }
};
