// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#include "CheckpointConnectWorker.h"

#include "CheckpointSourceControlCommand.h"
#include "CheckpointSourceControlModule.h"
#include "GenericPlatform/GenericPlatformFile.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformProcess.h"
#include "ISourceControlModule.h"
#include "Logging/MessageLog.h"
#include "Misc/MessageDialog.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "SourceControlHelpers.h"
#include "SourceControlOperations.h"

#include <thread>

#include "checkpoint.h"

#define LOCTEXT_NAMESPACE "CheckpointSourceControl"

FName FCheckpointConnectWorker::GetName() const {
  return "Connect";
}

bool FCheckpointConnectWorker::Execute(
  FCheckpointSourceControlCommand &InCommand
) {
  // The connect worker checks if we are connected to the remote server.
  check(InCommand.Operation->GetName() == GetName());
  TSharedRef<FConnect, ESPMode::ThreadSafe> Operation =
    StaticCastSharedRef<FConnect>(InCommand.Operation);

  Checkpoint::WhoamiResult *whoami = Checkpoint::Whoami();
  if (!whoami->success) {
    Checkpoint::FreeWhoami(whoami);
    Checkpoint::ErrorResult *login = Checkpoint::Login();
    if (!login->success) {
      Checkpoint::FreeError(login);
      const FText &NotLoggedIn =
        LOCTEXT("CheckpointLoginFailed", "Failed Checkpoint login.");
      InCommand.ResultInfo.ErrorMessages.Add(NotLoggedIn.ToString());
      Operation->SetErrorText(NotLoggedIn);
      InCommand.bCommandSuccessful = false;
      return false;
    } else {
      Checkpoint::FreeError(login);
    }
  } else {
    Checkpoint::FreeWhoami(whoami);
  }

  FString ProjectDir = FPaths::ProjectDir();
  const char *ProjectDirCStr = TCHAR_TO_UTF8(*ProjectDir);

  Checkpoint::WorkspaceResult *workspace =
    Checkpoint::GetWorkspaceDetails(ProjectDirCStr);

  if (!workspace->success) {
    Checkpoint::FreeWorkspace(workspace);
    const FText &NotValidWorkspace =
      LOCTEXT("CheckpointNotValidWorkspace", "Not a valid workspace.");
    InCommand.ResultInfo.ErrorMessages.Add(NotValidWorkspace.ToString());
    Operation->SetErrorText(NotValidWorkspace);
    InCommand.bCommandSuccessful = false;
    return false;
  } else {
    Checkpoint::FreeWorkspace(workspace);
  }

  InCommand.bCommandSuccessful = true;

  return InCommand.bCommandSuccessful;
}

bool FCheckpointConnectWorker::UpdateStates() const {
  return false;
}

#undef LOCTEXT_NAMESPACE
