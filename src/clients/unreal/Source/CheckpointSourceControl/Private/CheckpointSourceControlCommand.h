// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "ISourceControlOperation.h"
#include "ISourceControlProvider.h"

#include "ICheckpointSourceControlWorker.h"

/**
 * Wraps a source control operation and its worker for execution.
 */
class FCheckpointSourceControlCommand {
public:
  FCheckpointSourceControlCommand(
    const FSourceControlOperationRef& InOperation,
    const FCheckpointWorkerRef& InWorker,
    const FSourceControlOperationComplete& InDelegate
  ) : Operation(InOperation),
      Worker(InWorker),
      OperationCompleteDelegate(InDelegate),
      bExecuteProcessed(false),
      bCommandSuccessful(false),
      bAutoDelete(true),
      Concurrency(EConcurrency::Synchronous) {}

  /** Execute the worker */
  bool DoWork() {
    bCommandSuccessful = Worker->Execute(*this);
    bExecuteProcessed = true;
    return bCommandSuccessful;
  }

  /** Update states and fire completion delegate */
  ECommandResult::Type ReturnResults() {
    Worker->UpdateStates();

    ECommandResult::Type Result = bCommandSuccessful
      ? ECommandResult::Succeeded
      : ECommandResult::Failed;

    OperationCompleteDelegate.ExecuteIfBound(
      Operation,
      Result
    );

    return Result;
  }

public:
  /** The operation being executed */
  FSourceControlOperationRef Operation;

  /** The worker processing this command */
  FCheckpointWorkerRef Worker;

  /** Delegate to call on completion */
  FSourceControlOperationComplete OperationCompleteDelegate;

  /** Whether Execute() has been called */
  bool bExecuteProcessed;

  /** Whether the command succeeded */
  bool bCommandSuccessful;

  /** Whether to auto-delete after completion */
  bool bAutoDelete;

  /** How the command should be executed */
  EConcurrency::Type Concurrency;

  /** Files to operate on */
  TArray<FString> Files;

  /** Optional changelist */
  FSourceControlChangelistPtr Changelist;

  /** Result info from the operation */
  FSourceControlResultInfo ResultInfo;
};
