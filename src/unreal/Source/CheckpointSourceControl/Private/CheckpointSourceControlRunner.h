// Copyright Project Borealis

#pragma once

#include "CoreMinimal.h"

#include "HAL/Runnable.h"

#include "ISourceControlOperation.h"
#include "ISourceControlProvider.h"

/**
 *
 */
class FCheckpointSourceControlRunner : public FRunnable {
public:
  FCheckpointSourceControlRunner();

  // Destructor
  virtual ~FCheckpointSourceControlRunner() override;

  bool Init() override;
  uint32 Run() override;
  void Stop() override;
  void OnSourceControlOperationComplete(
    const FSourceControlOperationRef &InOperation, ECommandResult::Type InResult
  );

private:
  FRunnableThread *Thread;
  FEvent *StopEvent;
  bool bRunThread;
  bool bRefreshSpawned;
};
