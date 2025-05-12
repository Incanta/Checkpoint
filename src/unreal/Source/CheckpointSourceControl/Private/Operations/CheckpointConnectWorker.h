// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#pragma once

#include "CoreMinimal.h"
#include "ICheckpointSourceControlWorker.h"

#include "ISourceControlOperation.h"

/** Called when first activated on a project, and then at project load time.
 *  Look for the root directory of the Checkpoint workspace (where the ".checkpoint/" subdirectory is located).
 */
class FCheckpointConnectWorker : public ICheckpointSourceControlWorker {
public:
  virtual ~FCheckpointConnectWorker() {}
  // ICheckpointSourceControlWorker interface
  virtual FName GetName() const override;
  virtual bool Execute(
    class FCheckpointSourceControlCommand &InCommand
  ) override;
  virtual bool UpdateStates() const override;
};
