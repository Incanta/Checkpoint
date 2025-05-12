// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#include "CheckpointSourceControlModule.h"

#include "CheckpointMacros.h"

#include "AssetToolsModule.h"
#if StartingInVersion(5, 1)
  #include "Styling/AppStyle.h"
#else
  #include "EditorStyleSet.h"
#endif
#include "Features/IModularFeatures.h"
#include "Misc/App.h"
#include "Modules/ModuleManager.h"
#include "Interfaces/IPluginManager.h"

#include "ContentBrowserDelegates.h"
#include "ContentBrowserModule.h"

#include "CheckpointSourceControlOperations.h"
#include "Framework/Commands/UIAction.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Framework/MultiBox/MultiBoxExtender.h"
#include "ISourceControlModule.h"
#include "Misc/ConfigCacheIni.h"
#include "Runtime/Launch/Resources/Version.h"
#include "SourceControlHelpers.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl"

TArray<FString> FCheckpointSourceControlModule::EmptyStringArray;

namespace {
  static const FName NAME_SourceControl(TEXT("SourceControl"));
  static const FName NAME_ContentBrowser(TEXT("ContentBrowser"));
}

template <typename Type>
static TSharedRef<ICheckpointSourceControlWorker, ESPMode::ThreadSafe>
CreateWorker() {
  return MakeShareable(new Type());
}

void FCheckpointSourceControlModule::StartupModule() {
  FString baseDir = IPluginManager::Get().FindPlugin("CheckpointSourceControl")->GetBaseDir();

  FString libName = "LongtailWrapper";

#if PLATFORM_WINDOWS
  FString libExtension = "dll";
#elif PLATFORM_MAC
  FString libExtension = "dylib";
#else
  FString libExtension = "so";
#endif

#if PLATFORM_WINDOWS
  FString subDir = "win64";
#elif PLATFORM_MAC
  FString subDir = "mac";
#elif PLATFORM_LINUX
  FString subDir = "linux";
#endif

  // TODO: Support released location
  FString libraryPath = FPaths::Combine(
    *baseDir,
    TEXT("Source"),
    TEXT("ThirdParty"),
    TEXT("CheckpointLibrary"),
    subDir,
    libName + "." + libExtension
  );
  this->dllHandle = FPlatformProcess::GetDllHandle(*libraryPath);

  check(this->dllHandle != nullptr);

  // Register our operations (implemented in CheckpointSourceControlOperations.cpp by subclassing from Engine\Source\Developer\SourceControl\Public\SourceControlOperations.h)
  CheckpointSourceControlProvider.RegisterWorker(
    "Connect",
    FGetCheckpointSourceControlWorker::CreateStatic(
      &CreateWorker<FCheckpointConnectWorker>
    )
  );

  // Bind our revision control provider to the editor
  IModularFeatures::Get().RegisterModularFeature(
    NAME_SourceControl, &CheckpointSourceControlProvider
  );

  FContentBrowserModule &ContentBrowserModule =
    FModuleManager::Get().LoadModuleChecked<FContentBrowserModule>(
      NAME_ContentBrowser
    );

  // TODO MIKE HERE, wtf?
  // Register ContentBrowserDelegate Handles for UE5 EA
  // At the time of writing this UE5 is in Early Access and has no support for revision control yet. So instead we hook into the content browser..
  // .. and force a state update on the next tick for revision control. Usually the contentbrowser assets will request this themselves, but that's not working
  // Values here are 1 or 2 based on whether the change can be done immediately or needs to be delayed as unreal needs to work through its internal delegates first
  // >> Technically you wouldn't need to use `GetOnAssetSelectionChanged` -- but it's there as a safety mechanism. States aren't forceupdated for the first path that loads
  // >> Making sure we force an update on selection change that acts like a just in case other measures fail
  CbdHandle_OnFilterChanged =
    ContentBrowserModule.GetOnFilterChanged().AddLambda(
      [this](const FARFilter &, bool) {
        CheckpointSourceControlProvider.TicksUntilNextForcedUpdate = 2;
      }
    );
  CbdHandle_OnSearchBoxChanged =
    ContentBrowserModule.GetOnSearchBoxChanged().AddLambda(
      [this](const FText &, bool) {
        CheckpointSourceControlProvider.TicksUntilNextForcedUpdate = 1;
      }
    );
  CbdHandle_OnAssetSelectionChanged =
    ContentBrowserModule.GetOnAssetSelectionChanged().AddLambda(
      [this](const TArray<FAssetData> &, bool) {
        CheckpointSourceControlProvider.TicksUntilNextForcedUpdate = 1;
      }
    );
  CbdHandle_OnAssetPathChanged =
    ContentBrowserModule.GetOnAssetPathChanged().AddLambda(
      [this](const FString &) {
        CheckpointSourceControlProvider.TicksUntilNextForcedUpdate = 2;
      }
    );

  TArray<FContentBrowserMenuExtender_SelectedAssets>
    &CBAssetMenuExtenderDelegates =
      ContentBrowserModule.GetAllAssetViewContextMenuExtenders();
  CBAssetMenuExtenderDelegates.Add(
    FContentBrowserMenuExtender_SelectedAssets::CreateRaw(
      this,
      &FCheckpointSourceControlModule::OnExtendContentBrowserAssetSelectionMenu
    )
  );
  CbdHandle_OnExtendAssetSelectionMenu =
    CBAssetMenuExtenderDelegates.Last().GetHandle();
}

void FCheckpointSourceControlModule::ShutdownModule() {
  // shut down the provider, as this module is going away
  CheckpointSourceControlProvider.Close();

  // unbind provider from editor
  IModularFeatures::Get().UnregisterModularFeature(
    NAME_SourceControl, &CheckpointSourceControlProvider
  );

  // Unregister ContentBrowserDelegate Handles
  FContentBrowserModule &ContentBrowserModule =
    FModuleManager::Get().GetModuleChecked<FContentBrowserModule>(
      NAME_ContentBrowser
    );
  ContentBrowserModule.GetOnFilterChanged().Remove(CbdHandle_OnFilterChanged);
  ContentBrowserModule.GetOnSearchBoxChanged().Remove(
    CbdHandle_OnSearchBoxChanged
  );
  ContentBrowserModule.GetOnAssetSelectionChanged().Remove(
    CbdHandle_OnAssetSelectionChanged
  );
  ContentBrowserModule.GetOnAssetPathChanged().Remove(
    CbdHandle_OnAssetPathChanged
  );

  TArray<FContentBrowserMenuExtender_SelectedAssets>
    &CBAssetMenuExtenderDelegates =
      ContentBrowserModule.GetAllAssetViewContextMenuExtenders();
  CBAssetMenuExtenderDelegates.RemoveAll(
    [&ExtenderDelegateHandle = CbdHandle_OnExtendAssetSelectionMenu](
      const FContentBrowserMenuExtender_SelectedAssets &Delegate
    ) { return Delegate.GetHandle() == ExtenderDelegateHandle; }
  );

  if (this->dllHandle != nullptr) {
    FPlatformProcess::FreeDllHandle(this->dllHandle);
    this->dllHandle = nullptr;
  }
}

void FCheckpointSourceControlModule::SetLastErrors(
  const TArray<FText> &InErrors
) {
  FCheckpointSourceControlModule *Module =
    FModuleManager::GetModulePtr<FCheckpointSourceControlModule>(
      "CheckpointSourceControl"
    );
  if (Module) {
    Module->GetProvider().SetLastErrors(InErrors);
  }
}

TSharedRef<FExtender>
FCheckpointSourceControlModule::OnExtendContentBrowserAssetSelectionMenu(
  const TArray<FAssetData> &SelectedAssets
) {
  TSharedRef<FExtender> Extender(new FExtender());

  // Extender->AddMenuExtension(
  //   "AssetSourceControlActions",
  //   EExtensionHook::After,
  //   nullptr,
  //   FMenuExtensionDelegate::CreateRaw(
  //     this,
  //     &FCheckpointSourceControlModule::CreateContentBrowserAssetMenu,
  //     SelectedAssets
  //   )
  // );

  return Extender;
}

void FCheckpointSourceControlModule::CreateContentBrowserAssetMenu(
  FMenuBuilder &MenuBuilder, const TArray<FAssetData> SelectedAssets
) {
  if (!FCheckpointSourceControlModule::Get()
         .GetProvider()
         .GetStatusBranchNames()
         .Num()) {
    return;
  }

//   const TArray<FString> &StatusBranchNames =
//     FCheckpointSourceControlModule::Get().GetProvider().GetStatusBranchNames();
//   const FString &BranchName = StatusBranchNames[0];
//   MenuBuilder.AddMenuEntry(
//     FText::Format(
//       LOCTEXT("StatusBranchDiff", "Diff against status branch"),
//       FText::FromString(BranchName)
//     ),
//     FText::Format(
//       LOCTEXT(
//         "StatusBranchDiffDesc",
//         "Compare this asset to the latest status branch version"
//       ),
//       FText::FromString(BranchName)
//     ),
// #if StartingInVersion(5, 1)
//     FSlateIcon(FAppStyle::GetAppStyleSetName(), "SourceControl.Actions.Diff"),
// #else
//     FSlateIcon(FEditorStyle::GetStyleSetName(), "SourceControl.Actions.Diff"),
// #endif
//     FUIAction(
//       FExecuteAction::CreateRaw(
//         this,
//         &FCheckpointSourceControlModule::DiffAssetAgainstGitOriginBranch,
//         SelectedAssets,
//         BranchName
//       )
//     )
//   );
}

IMPLEMENT_MODULE(FCheckpointSourceControlModule, CheckpointSourceControl);

#undef LOCTEXT_NAMESPACE
