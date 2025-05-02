#include "progress.h"

void Progress_OnProgress(
    struct Longtail_ProgressAPI* progress_api,
    uint32_t total,
    uint32_t jobs_done) {
  struct Progress* p = (struct Progress*)progress_api;
  if (jobs_done < total) {
    if (!p->m_UpdateCount) {
      if (Longtail_GetLogLevel() <= LONGTAIL_LOG_LEVEL_DEBUG) {
        fprintf(stderr, "%s: ", p->m_Task);
      }
    }

    uint32_t percent_done = (100 * jobs_done) / total;
    if (Longtail_GetLogLevel() <= LONGTAIL_LOG_LEVEL_DEBUG) {
      fprintf(stderr, "%u%% ", percent_done);
    }
    ++p->m_UpdateCount;
    return;
  }

  if (p->m_UpdateCount) {
    if (Longtail_GetLogLevel() <= LONGTAIL_LOG_LEVEL_DEBUG) {
      fprintf(stderr, "100%%");
    }
  }
}

void Progress_Dispose(struct Longtail_API* api) {
  struct Progress* me = (struct Progress*)api;
  if (me->m_UpdateCount) {
    if (Longtail_GetLogLevel() <= LONGTAIL_LOG_LEVEL_DEBUG) {
      fprintf(stderr, " Done\n");
    }
  }
  Longtail_Free(me);
}

struct Longtail_ProgressAPI* MakeProgressAPI(const char* task) {
  void* mem = Longtail_Alloc(0, sizeof(struct Progress));

  if (!mem) {
    return 0;
  }

  struct Longtail_ProgressAPI* progress_api = Longtail_MakeProgressAPI(
      mem,
      Progress_Dispose,
      Progress_OnProgress);

  if (!progress_api) {
    Longtail_Free(mem);
    return 0;
  }

  struct Progress* me = (struct Progress*)progress_api;
  me->m_RateLimitedProgressAPI = Longtail_CreateRateLimitedProgress(progress_api, 5);
  me->m_Task = task;
  me->m_UpdateCount = 0;
  return me->m_RateLimitedProgressAPI;
}
