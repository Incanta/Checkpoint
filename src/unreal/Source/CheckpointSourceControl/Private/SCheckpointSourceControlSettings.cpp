// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#include "SCheckpointSourceControlSettings.h"

#include "CheckpointMacros.h"

#include "EditorDirectories.h"
#include "Fonts/SlateFontInfo.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Misc/App.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Runtime/Launch/Resources/Version.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SFilePathPicker.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/Notifications/SNotificationList.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#if StartingInVersion(5, 1)
#else
  #include "EditorStyleSet.h"
#endif
#include "CheckpointSourceControlModule.h"
#include "SourceControlOperations.h"

#define LOCTEXT_NAMESPACE "SCheckpointSourceControlSettings"

void SCheckpointSourceControlSettings::Construct(const FArguments &InArgs) {
  bAutoCreateIgnore = true;

  ConstructBasedOnEngineVersion();
}

void SCheckpointSourceControlSettings::ConstructBasedOnEngineVersion() {
  const FText FileFilterType =
    NSLOCTEXT("CheckpointSourceControl", "Executables", "Executables");
#if PLATFORM_WINDOWS
  const FString FileFilterText =
    FString::Printf(TEXT("%s"), *FileFilterType.ToString());
#else
  const FString FileFilterText =
    FString::Printf(TEXT("%s"), *FileFilterType.ToString());
#endif

  using Self = std::remove_pointer_t<decltype(this)>;

#define ROW_LEFT(PADDING_HEIGHT) \
  +SHorizontalBox::Slot() \
     .VAlign(VAlign_Center) \
     .HAlign(HAlign_Right) \
     .FillWidth(1.0f) \
     .Padding(FMargin(0.0f, 0.0f, 16.0f, PADDING_HEIGHT))

#define ROW_RIGHT(PADDING_HEIGHT) \
  +SHorizontalBox::Slot() \
     .VAlign(VAlign_Center) \
     .FillWidth(2.0f) \
     .Padding(FMargin(0.0f, 0.0f, 0.0f, PADDING_HEIGHT))

#define TT_BinPath \
  LOCTEXT("BinaryPathLabel_Tooltip", "Path to Checkpoint binary")
#define TT_WorkspaceRoot \
  LOCTEXT( \
    "WorkspaceRootLabel_Tooltip", \
    "Path to the root of the Checkpoint workspace" \
  )

  ChildSlot
    [SNew(SVerticalBox)
     // Workspace Root
     + SVerticalBox::Slot()[SNew(SHorizontalBox) ROW_LEFT(
         10.0f
       )[SNew(STextBlock)
           .Text(LOCTEXT("WorkspaceRootLabel", "Root of the Workspace"))
           .ToolTipText(TT_WorkspaceRoot)] ROW_RIGHT(10.0f)
                              [SNew(STextBlock)
                                 .Text(this, &Self::GetPathToWorkspaceRoot)
                                 .ToolTipText(TT_WorkspaceRoot)]]];
}

SCheckpointSourceControlSettings::~SCheckpointSourceControlSettings() {
  RemoveInProgressNotification();
}

FText SCheckpointSourceControlSettings::GetPathToWorkspaceRoot() const {
  const FCheckpointSourceControlModule &CheckpointSourceControl =
    FCheckpointSourceControlModule::Get();
  const FString &PathToWorkspaceRoot =
    CheckpointSourceControl.GetProvider().GetPathToWorkspaceRoot();
  return FText::FromString(PathToWorkspaceRoot);
}

EVisibility SCheckpointSourceControlSettings::MustInitializeWorkspace() const {
  const FCheckpointSourceControlModule &CheckpointSourceControl =
    FCheckpointSourceControlModule::Get();
  const bool bEnabled =
    CheckpointSourceControl.GetProvider().IsEnabled();
#if 0
	return (!bEnabled) ? EVisibility::Visible : EVisibility::Collapsed;
#else
  return EVisibility::Collapsed;
#endif
}

bool SCheckpointSourceControlSettings::CanInitializeWorkspace() const {
  const FCheckpointSourceControlModule &CheckpointSourceControl =
    FCheckpointSourceControlModule::Get();
  const bool bEnabled =
    CheckpointSourceControl.GetProvider().IsEnabled();
#if 0
	return (!bEnabled);
#else
  return false;
#endif
}

FReply SCheckpointSourceControlSettings::OnClickedInitializeWorkspace() {
  FCheckpointSourceControlModule &CheckpointSourceControl =
    FCheckpointSourceControlModule::Get();
  const FString PathToProjectDir =
    FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
  TArray<FString> InfoMessages;
  TArray<FString> ErrorMessages;

  // Check the new repository status to enable connection (branch, user e-mail)
  if (CheckpointSourceControl.GetProvider().IsAvailable()) {
    // List of files to add to Revision Control (.uproject, Config/, Content/, Source/ files and .ignore if any)
    TArray<FString> ProjectFiles;
    ProjectFiles.Add(FPaths::ProjectContentDir());
    ProjectFiles.Add(FPaths::ProjectConfigDir());
    ProjectFiles.Add(FPaths::GetProjectFilePath());
    if (FPaths::DirectoryExists(FPaths::GameSourceDir())) {
      ProjectFiles.Add(FPaths::GameSourceDir());
    }
    if (bAutoCreateIgnore) {
      // 2.a. Create a standard ".ignore" file with common patterns for a typical Blueprint & C++ project
      const FString IgnoreFilename =
        FPaths::Combine(FPaths::ProjectDir(), TEXT(".ignore"));
      const FString IgnoreContent = TEXT(
        "Binaries\nDerivedDataCache\nIntermediate\nSaved\n.vscode\n.vs\n*.VC.db\n*.opensdf\n*.opendb\n*.sdf\n*.sln\n*.suo\n*.xcodeproj\n*.xcworkspace\n*.log"
      );
      if (FFileHelper::SaveStringToFile(
            IgnoreContent,
            *IgnoreFilename,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM
          )) {
        ProjectFiles.Add(IgnoreFilename);
      }
    }
  }
  return FReply::Handled();
}

/// Delegate called when a Revision control operation has completed: launch the next one and manage notifications
void SCheckpointSourceControlSettings::OnSourceControlOperationComplete(
  const FSourceControlOperationRef &InOperation, ECommandResult::Type InResult
) {
  RemoveInProgressNotification();

  // Report result with a notification
  if (InResult == ECommandResult::Succeeded) {
    DisplaySuccessNotification(InOperation);
  } else {
    DisplayFailureNotification(InOperation);
  }
}

// Display an ongoing notification during the whole operation
void SCheckpointSourceControlSettings::DisplayInProgressNotification(
  const FSourceControlOperationRef &InOperation
) {
  FNotificationInfo Info(InOperation->GetInProgressString());
  Info.bFireAndForget = false;
  Info.ExpireDuration = 0.0f;
  Info.FadeOutDuration = 1.0f;
  OperationInProgressNotification =
    FSlateNotificationManager::Get().AddNotification(Info);
  if (OperationInProgressNotification.IsValid()) {
    OperationInProgressNotification.Pin()->SetCompletionState(
      SNotificationItem::CS_Pending
    );
  }
}

// Remove the ongoing notification at the end of the operation
void SCheckpointSourceControlSettings::RemoveInProgressNotification() {
  if (OperationInProgressNotification.IsValid()) {
    OperationInProgressNotification.Pin()->ExpireAndFadeout();
    OperationInProgressNotification.Reset();
  }
}

// Display a temporary success notification at the end of the operation
void SCheckpointSourceControlSettings::DisplaySuccessNotification(
  const FSourceControlOperationRef &InOperation
) {
  const FText NotificationText = FText::Format(
    LOCTEXT("InitialCommit_Success", "{0} operation was successfull!"),
    FText::FromName(InOperation->GetName())
  );
  FNotificationInfo Info(NotificationText);
  Info.bUseSuccessFailIcons = true;
#if StartingInVersion(5, 1)
  Info.Image = FAppStyle::GetBrush(TEXT("NotificationList.SuccessImage"));
#else
  Info.Image = FEditorStyle::GetBrush(TEXT("NotificationList.SuccessImage"));
#endif
  FSlateNotificationManager::Get().AddNotification(Info);
}

// Display a temporary failure notification at the end of the operation
void SCheckpointSourceControlSettings::DisplayFailureNotification(
  const FSourceControlOperationRef &InOperation
) {
  const FText NotificationText = FText::Format(
    LOCTEXT("InitialCommit_Failure", "Error: {0} operation failed!"),
    FText::FromName(InOperation->GetName())
  );
  FNotificationInfo Info(NotificationText);
  Info.ExpireDuration = 8.0f;
  FSlateNotificationManager::Get().AddNotification(Info);
}

void SCheckpointSourceControlSettings::OnCheckedCreateIgnore(
  ECheckBoxState NewCheckedState
) {
  bAutoCreateIgnore = (NewCheckedState == ECheckBoxState::Checked);
}

#undef LOCTEXT_NAMESPACE
