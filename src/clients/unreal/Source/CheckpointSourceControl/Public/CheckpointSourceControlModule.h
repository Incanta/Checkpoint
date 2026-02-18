// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "Modules/ModuleInterface.h"
#include "Modules/ModuleManager.h"

#include "CheckpointSourceControlProvider.h"

DECLARE_LOG_CATEGORY_EXTERN(LogCheckpointSourceControl, Log, All);

class FCheckpointSourceControlModule : public IModuleInterface {
public:
  /** IModuleInterface implementation */
  virtual void StartupModule() override;
  virtual void ShutdownModule() override;

  /** Access the provider */
  FCheckpointSourceControlProvider& GetProvider() {
    return CheckpointSourceControlProvider;
  }

private:
  FCheckpointSourceControlProvider CheckpointSourceControlProvider;
};
