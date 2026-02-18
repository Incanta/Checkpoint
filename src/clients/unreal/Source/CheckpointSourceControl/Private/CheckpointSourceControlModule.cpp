// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointSourceControlModule.h"

#include "CheckpointSourceControlOperations.h"
#include "Features/IModularFeatures.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl"

DEFINE_LOG_CATEGORY(LogCheckpointSourceControl);

void FCheckpointSourceControlModule::StartupModule() {
  // Register workers for all supported operations
  CheckpointSourceControlWorkers::RegisterWorkers();

  // Register our provider as a modular feature so UE can
  // discover it
  IModularFeatures::Get().RegisterModularFeature(
    "SourceControl",
    &CheckpointSourceControlProvider
  );
}

void FCheckpointSourceControlModule::ShutdownModule() {
  CheckpointSourceControlProvider.Close();

  IModularFeatures::Get().UnregisterModularFeature(
    "SourceControl",
    &CheckpointSourceControlProvider
  );
}

IMPLEMENT_MODULE(
  FCheckpointSourceControlModule,
  CheckpointSourceControl
)

#undef LOCTEXT_NAMESPACE
