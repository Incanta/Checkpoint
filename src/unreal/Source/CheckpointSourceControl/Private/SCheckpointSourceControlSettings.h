// Copyright (c) 2014-2020 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#pragma once

#include "CheckpointMacros.h"

#include "ISourceControlProvider.h"
#include "Runtime/Launch/Resources/Version.h"
#include "Widgets/SCompoundWidget.h"

class SNotificationItem;
#if StartingInVersion(5, 2)
namespace ETextCommit {
  enum Type : int;
}
#else
namespace ETextCommit {
  enum Type;
}
#endif

enum class ECheckBoxState : uint8;

class SCheckpointSourceControlSettings : public SCompoundWidget {
public:
  SLATE_BEGIN_ARGS(SCheckpointSourceControlSettings) {}

  SLATE_END_ARGS()

public:
  void Construct(const FArguments &InArgs);

  ~SCheckpointSourceControlSettings();

private:
  void ConstructBasedOnEngineVersion();

  /** Delegate to get workspace root, user name and email from provider */
  FText GetPathToWorkspaceRoot() const;

  EVisibility MustInitializeWorkspace() const;
  bool CanInitializeWorkspace() const;

  /** Delegate to initialize a new Checkpoint workspace */
  FReply OnClickedInitializeWorkspace();

  void OnCheckedCreateIgnore(ECheckBoxState NewCheckedState);
  bool bAutoCreateIgnore;

  /** Delegate called when a revision control operation has completed */
  void OnSourceControlOperationComplete(
    const FSourceControlOperationRef &InOperation, ECommandResult::Type InResult
  );

  /** Asynchronous operation progress notifications */
  TWeakPtr<SNotificationItem> OperationInProgressNotification;

  void DisplayInProgressNotification(
    const FSourceControlOperationRef &InOperation
  );
  void RemoveInProgressNotification();
  void DisplaySuccessNotification(
    const FSourceControlOperationRef &InOperation
  );
  void DisplayFailureNotification(
    const FSourceControlOperationRef &InOperation
  );
};
