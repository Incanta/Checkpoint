// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ICheckpointSourceControlWorker.h"

#include "CheckpointSourceControlState.h"

/**
 * Worker for the Connect operation.
 * Tests connection to the daemon and retrieves user info.
 */
class FCheckpointConnectWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointConnectWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("Connect");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;
};

/**
 * Worker for the CheckOut operation.
 * Checks out files for editing via the daemon.
 */
class FCheckpointCheckOutWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointCheckOutWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("CheckOut");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  TArray<FString> UpdatedFiles;
};

/**
 * Worker for the CheckIn operation.
 * Submits a pending changelist via the daemon: the command's changelist, or
 * the domain root's default one when none is given.
 */
class FCheckpointCheckInWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointCheckInWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("CheckIn");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  TArray<FString> SubmittedFiles;

  /** The changelist that was submitted */
  FCheckpointSourceControlChangelist SubmittedChangelist;

  /** Whether the submit went through */
  bool bSubmitted = false;
};

/**
 * Worker for the MarkForAdd operation.
 * Unreal requires this name; Checkpoint has no "mark for add", so it stages
 * the untracked files instead, which is what makes a submit take them.
 */
class FCheckpointMarkForAddWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointMarkForAddWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("MarkForAdd");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  TArray<FString> AddedFiles;

  /** The changelist the files were staged into */
  FCheckpointSourceControlChangelist DestinationChangelist;
};

/**
 * Worker for the Delete operation.
 * Marks files for deletion.
 */
class FCheckpointDeleteWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointDeleteWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("Delete");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  TArray<FString> DeletedFiles;
};

/**
 * Worker for the Revert operation.
 * Undoes checkouts and reverts modifications.
 */
class FCheckpointRevertWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointRevertWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("Revert");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  TArray<FString> RevertedFiles;
};

/**
 * Worker for the RevertUnchanged operation.
 * Reverts only the files whose content is identical to their head version,
 * releasing their checkouts. With no files, works on the command's
 * changelist, or every pending change when there is none.
 */
class FCheckpointRevertUnchangedWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointRevertUnchangedWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("RevertUnchanged");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  TArray<FString> RevertedFiles;
};

/**
 * Worker for the Sync operation.
 * Pulls latest changes from the server.
 */
class FCheckpointSyncWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointSyncWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("Sync");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  /** File states discovered after sync */
  TMap<FString, ECheckpointFileStatus::Type> FileStates;

  /** The subset of FileStates the daemon has staged */
  TSet<FString> StagedFiles;
};

/**
 * Worker for the UpdateStatus operation.
 * Queries file status from the daemon.
 */
class FCheckpointUpdateStatusWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointUpdateStatusWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("UpdateStatus");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  /** States discovered during execution */
  TMap<FString, ECheckpointFileStatus::Type> FileStates;

  /** The subset of FileStates the daemon has staged */
  TSet<FString> StagedFiles;

  /** History entries per file */
  TMap<
    FString,
    TArray<TSharedRef<FCheckpointSourceControlRevision, ESPMode::ThreadSafe>>>
    FileHistories;

  /** Other users who have files checked out */
  TMap<FString, FString> OtherCheckouts;

  /** Absolute path -> the branch a blocking claim is held on. */
  TMap<FString, FString> ClaimBranches;

  /** Files that are locked by others */
  TSet<FString> LockedFiles;
};

/**
 * Worker for the Copy operation.
 * Not fully supported by Checkpoint.
 */
class FCheckpointCopyWorker final : public ICheckpointSourceControlWorker {
public:
  FCheckpointCopyWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("Copy");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override {
    return true;
  }
};

/**
 * Worker for getting file lists.
 */
class FCheckpointGetFileListWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointGetFileListWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("GetFileList");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override {
    return true;
  }
};

/**
 * Worker for the UpdateChangelistsStatus operation.
 * Rebuilds every pending changelist (numbered ones and each branch's
 * default) with its description and files.
 */
class FCheckpointUpdateChangelistsStatusWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointUpdateChangelistsStatusWorker(
    FCheckpointSourceControlProvider &InProvider
  ) : ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("UpdateChangelistsStatus");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  /** Every changelist that exists, with its description */
  TMap<FCheckpointSourceControlChangelist, FString> ChangelistDescriptions;

  /** Absolute path -> status, for the files in each changelist */
  TMap<
    FCheckpointSourceControlChangelist,
    TMap<FString, ECheckpointFileStatus::Type>>
    ChangelistFiles;

  /** Absolute paths of the files in ChangelistFiles the daemon has staged */
  TSet<FString> StagedFiles;

  /** Whether file membership was fetched, so ChangelistFiles is complete */
  bool bUpdatedFiles = false;

  /** Whether the changelists themselves were fetched */
  bool bUpdated = false;
};

/**
 * Worker for the NewChangelist operation.
 * Creates a numbered pending changelist and stages any given files into it.
 */
class FCheckpointNewChangelistWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointNewChangelistWorker(FCheckpointSourceControlProvider &InProvider) :
    ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("NewChangelist");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  /** The changelist that was created */
  FCheckpointSourceControlChangelist NewChangelist;

  FString NewDescription;

  /** Files moved into the new changelist */
  TArray<FString> MovedFiles;

  bool bCreated = false;
};

/**
 * Worker for the DeleteChangelist operation.
 * Deletes a numbered pending changelist; its files stay staged.
 */
class FCheckpointDeleteChangelistWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointDeleteChangelistWorker(
    FCheckpointSourceControlProvider &InProvider
  ) : ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("DeleteChangelist");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  FCheckpointSourceControlChangelist DeletedChangelist;

  bool bDeleted = false;
};

/**
 * Worker for the EditChangelist operation.
 * Sets the description of a numbered or default pending changelist.
 */
class FCheckpointEditChangelistWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointEditChangelistWorker(
    FCheckpointSourceControlProvider &InProvider
  ) : ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("EditChangelist");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  FCheckpointSourceControlChangelist EditedChangelist;

  FString EditedDescription;

  bool bEdited = false;
};

/**
 * Worker for the MoveToChangelist operation.
 * Stages files into a numbered pending changelist or a branch's default one.
 */
class FCheckpointMoveToChangelistWorker final
  : public ICheckpointSourceControlWorker {
public:
  FCheckpointMoveToChangelistWorker(
    FCheckpointSourceControlProvider &InProvider
  ) : ICheckpointSourceControlWorker(InProvider) {}

  virtual FName GetName() const override {
    return TEXT("MoveToChangelist");
  }

  virtual bool Execute(FCheckpointSourceControlCommand &InCommand) override;

  virtual bool UpdateStates() override;

  FCheckpointSourceControlChangelist DestinationChangelist;

  /** Files moved into the destination changelist */
  TArray<FString> MovedFiles;
};

// Worker registration
namespace CheckpointSourceControlWorkers {
  void RegisterWorkers();
}
