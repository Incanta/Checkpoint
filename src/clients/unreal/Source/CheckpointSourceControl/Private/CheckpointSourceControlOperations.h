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
 * Submits changes via the daemon.
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
};

/**
 * Worker for the MarkForAdd operation.
 * Marks untracked files for addition.
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

  /** History entries per file */
  TMap<
    FString,
    TArray<TSharedRef<FCheckpointSourceControlRevision, ESPMode::ThreadSafe>>>
    FileHistories;

  /** Other users who have files checked out */
  TMap<FString, FString> OtherCheckouts;

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
 * Populates changelist state with pending file changes.
 * Currently only supports the default changelist (local changes).
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

  /** File states collected for the default changelist */
  TMap<FString, ECheckpointFileStatus::Type> DefaultChangelistFiles;

  /** Other user checkout info */
  TMap<FString, FString> OtherCheckouts;

  /** Locked files */
  TSet<FString> LockedFiles;
};

// Worker registration
namespace CheckpointSourceControlWorkers {
  void RegisterWorkers();
}
