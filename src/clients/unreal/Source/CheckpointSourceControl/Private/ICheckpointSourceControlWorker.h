// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"

class FCheckpointSourceControlCommand;
class FCheckpointSourceControlProvider;

/**
 * Abstract base for workers that execute source control operations.
 * Each worker handles one type of operation (matching by name).
 */
class ICheckpointSourceControlWorker {
public:
  ICheckpointSourceControlWorker(
    FCheckpointSourceControlProvider& InProvider
  ) : Provider(InProvider) {}

  virtual ~ICheckpointSourceControlWorker() = default;

  /** Get the operation name this worker handles */
  virtual FName GetName() const = 0;

  /**
   * Execute the operation. May run on a background thread.
   * @return true if the operation succeeded
   */
  virtual bool Execute(
    FCheckpointSourceControlCommand& InCommand
  ) = 0;

  /**
   * Update the provider's state cache after execution.
   * Always runs on the game thread.
   * @return true if states were updated
   */
  virtual bool UpdateStates() = 0;

protected:
  FCheckpointSourceControlProvider& GetProvider() {
    return Provider;
  }

private:
  FCheckpointSourceControlProvider& Provider;
};

typedef TSharedRef<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
  FCheckpointWorkerRef;
