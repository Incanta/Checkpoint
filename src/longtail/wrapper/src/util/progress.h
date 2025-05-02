#pragma once

#include "../exposed/main.h"

struct Progress {
  struct Longtail_ProgressAPI m_API;
  struct Longtail_ProgressAPI* m_RateLimitedProgressAPI;
  const char* m_Task;
  uint32_t m_UpdateCount;
};

void Progress_OnProgress(
    struct Longtail_ProgressAPI* progress_api,
    uint32_t total,
    uint32_t jobs_done);

struct Longtail_ProgressAPI* MakeProgressAPI(const char* task);
