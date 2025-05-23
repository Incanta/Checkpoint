// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#pragma once

#include "Templates/SharedPointer.h"

class ICheckpointSourceControlWorker {
public:
  /**
   * Name describing the work that this worker does. Used for factory method hookup.
   */
  virtual FName GetName() const = 0;

  /**
   * Function that actually does the work. Can be executed on another thread.
   */
  virtual bool Execute(class FCheckpointSourceControlCommand &InCommand) = 0;

  /**
   * Updates the state of any items after completion (if necessary). This is always executed on the main thread.
   * @returns true if states were updated
   */
  virtual bool UpdateStates() const = 0;
};

typedef TSharedRef<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
  FCheckpointSourceControlWorkerRef;
