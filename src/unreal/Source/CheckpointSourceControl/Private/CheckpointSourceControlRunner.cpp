// Copyright Project Borealis

#include "CheckpointSourceControlRunner.h"

#include "CheckpointSourceControlModule.h"
#include "CheckpointSourceControlOperations.h"
#include "CheckpointSourceControlProvider.h"

#include "Async/Async.h"

FCheckpointSourceControlRunner::FCheckpointSourceControlRunner() {
  bRunThread = true;
  bRefreshSpawned = false;
  StopEvent = FPlatformProcess::GetSynchEventFromPool(true);
  Thread = FRunnableThread::Create(this, TEXT("CheckpointSourceControlRunner"));
}

FCheckpointSourceControlRunner::~FCheckpointSourceControlRunner() {
  if (Thread) {
    Thread->Kill();
    delete StopEvent;
    delete Thread;
  }
}

bool FCheckpointSourceControlRunner::Init() {
  return true;
}

uint32 FCheckpointSourceControlRunner::Run() {
  while (bRunThread) {
    StopEvent->Wait(30000);
    if (!bRunThread) {
      break;
    }
    // If we're not running the task already
    if (!bRefreshSpawned) {
      // Flag that we're running the task already
      bRefreshSpawned = true;
      const auto ExecuteResult =
        Async(EAsyncExecution::TaskGraphMainThread, [this] {
          FCheckpointSourceControlModule *CheckpointSourceControl =
            FCheckpointSourceControlModule::GetThreadSafe();
          // Module not loaded, bail. Usually happens when editor is shutting down, and this prevents a crash from bad timing.
          if (!CheckpointSourceControl) {
            return ECommandResult::Failed;
          }
          // FCheckpointSourceControlProvider &Provider =
          //   CheckpointSourceControl->GetProvider();
          // TSharedRef<FGitFetch, ESPMode::ThreadSafe> RefreshOperation =
          //   ISourceControlOperation::Create<FGitFetch>();
          // RefreshOperation->bUpdateStatus = true;
          // const ECommandResult::Type Result = Provider.Execute(
          //   RefreshOperation,
          //   FSourceControlChangelistPtr(),
          //   FCheckpointSourceControlModule::GetEmptyStringArray(),
          //   EConcurrency::Asynchronous,
          //   FSourceControlOperationComplete::CreateRaw(
          //     this,
          //     &FCheckpointSourceControlRunner::OnSourceControlOperationComplete
          //   )
          // );
          return ECommandResult::Succeeded;
        });
      // Wait for result if not already completed
      if (bRefreshSpawned && bRunThread) {
        // Get the result
        ECommandResult::Type Result = ExecuteResult.Get();
        // If still not completed,
        if (bRefreshSpawned) {
          // mark failures as done, successes have to complete
          bRefreshSpawned = Result == ECommandResult::Succeeded;
        }
      }
    }
  }

  return 0;
}

void FCheckpointSourceControlRunner::Stop() {
  bRunThread = false;
  StopEvent->Trigger();
}

void FCheckpointSourceControlRunner::OnSourceControlOperationComplete(
  const FSourceControlOperationRef &InOperation, ECommandResult::Type InResult
) {
  // Mark task as done
  bRefreshSpawned = false;
}
