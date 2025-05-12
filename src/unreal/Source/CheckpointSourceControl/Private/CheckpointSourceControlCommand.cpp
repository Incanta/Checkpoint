// Copyright (c) 2014-2023 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#include "CheckpointSourceControlCommand.h"

#include "CheckpointSourceControlModule.h"
#include "Modules/ModuleManager.h"

FCheckpointSourceControlCommand::FCheckpointSourceControlCommand(
  const TSharedRef<class ISourceControlOperation, ESPMode::ThreadSafe>
    &InOperation,
  const TSharedRef<class ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
    &InWorker,
  const FSourceControlOperationComplete &InOperationCompleteDelegate
) :
  Operation(InOperation), Worker(InWorker),
  OperationCompleteDelegate(InOperationCompleteDelegate), bExecuteProcessed(0),
  bCancelled(0), bCommandSuccessful(false), bAutoDelete(true),
  Concurrency(EConcurrency::Synchronous) {
  //
}

bool FCheckpointSourceControlCommand::DoWork() {
  bCommandSuccessful = Worker->Execute(*this);
  FPlatformAtomics::InterlockedExchange(&bExecuteProcessed, 1);

  return bCommandSuccessful;
}

void FCheckpointSourceControlCommand::Abandon() {
  FPlatformAtomics::InterlockedExchange(&bExecuteProcessed, 1);
}

void FCheckpointSourceControlCommand::DoThreadedWork() {
  Concurrency = EConcurrency::Asynchronous;
  DoWork();
}

void FCheckpointSourceControlCommand::Cancel() {
  FPlatformAtomics::InterlockedExchange(&bCancelled, 1);
}

bool FCheckpointSourceControlCommand::IsCanceled() const {
  return bCancelled != 0;
}

ECommandResult::Type FCheckpointSourceControlCommand::ReturnResults() {
  // Save any messages that have accumulated
  for (const auto &String : ResultInfo.InfoMessages) {
    Operation->AddInfoMessge(FText::FromString(String));
  }
  for (const auto &String : ResultInfo.ErrorMessages) {
    Operation->AddErrorMessge(FText::FromString(String));
  }

  // run the completion delegate if we have one bound
  ECommandResult::Type Result = bCancelled
    ? ECommandResult::Cancelled
    : (bCommandSuccessful ? ECommandResult::Succeeded : ECommandResult::Failed);
  OperationCompleteDelegate.ExecuteIfBound(Operation, Result);

  return Result;
}
