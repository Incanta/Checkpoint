// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#pragma once

#include "Modules/ModuleInterface.h"
#include "Modules/ModuleManager.h"

#include "CheckpointSourceControlProvider.h"

struct FAssetData;
class FExtender;

class FCheckpointSourceControlModule : public IModuleInterface {
public:
  /** IModuleInterface implementation */
  virtual void StartupModule() override;
  virtual void ShutdownModule() override;

  FCheckpointSourceControlProvider &GetProvider() {
    return CheckpointSourceControlProvider;
  }

  const FCheckpointSourceControlProvider &GetProvider() const {
    return CheckpointSourceControlProvider;
  }

  CHECKPOINTSOURCECONTROL_API static const TArray<FString> &GetEmptyStringArray(
  ) {
    return EmptyStringArray;
  }

  /**
   * Singleton-like access to this module's interface.  This is just for convenience!
   * Beware of calling this during the shutdown phase, though.  Your module might have been unloaded already.
   *
   * @return Returns singleton instance, loading the module on demand if needed
   */
  static inline FCheckpointSourceControlModule &Get() {
    return FModuleManager::Get()
      .LoadModuleChecked<FCheckpointSourceControlModule>(
        "CheckpointSourceControl"
      );
  }

  static inline FCheckpointSourceControlModule *GetThreadSafe() {
    IModuleInterface *ModulePtr =
      FModuleManager::Get().GetModule("CheckpointSourceControl");
    if (!ModulePtr) {
      // Main thread should never have this unloaded.
      check(!IsInGameThread());
      return nullptr;
    }
    return static_cast<FCheckpointSourceControlModule *>(ModulePtr);
  }

  /** Set list of error messages that occurred after last Checkpoint command */
  static void SetLastErrors(const TArray<FText> &InErrors);

private:
  TSharedRef<FExtender> OnExtendContentBrowserAssetSelectionMenu(
    const TArray<FAssetData> &SelectedAssets
  );
  void CreateContentBrowserAssetMenu(
    FMenuBuilder &MenuBuilder, const TArray<FAssetData> SelectedAssets
  );

  FCheckpointSourceControlProvider CheckpointSourceControlProvider;

  static TArray<FString> EmptyStringArray;

  // ContentBrowserDelegate Handles
  FDelegateHandle CbdHandle_OnFilterChanged;
  FDelegateHandle CbdHandle_OnSearchBoxChanged;
  FDelegateHandle CbdHandle_OnAssetSelectionChanged;
  FDelegateHandle CbdHandle_OnSourcesViewChanged;
  FDelegateHandle CbdHandle_OnAssetPathChanged;
  FDelegateHandle CbdHandle_OnExtendAssetSelectionMenu;

  void * dllHandle;
};
