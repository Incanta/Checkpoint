// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlChangelistState.h"

#include "CheckpointSourceControlChangelist.h"

/**
 * State for a Checkpoint pending changelist: its description and the files
 * in it.
 */
class FCheckpointSourceControlChangelistState
  : public ISourceControlChangelistState {
public:
  explicit FCheckpointSourceControlChangelistState(
    const FCheckpointSourceControlChangelist& InChangelist
  ) : Changelist(InChangelist) {}

  // ISourceControlChangelistState
  virtual FName GetIconName() const override {
    return FName("SourceControl.Changelist");
  }

  virtual FName GetSmallIconName() const override {
    return FName("SourceControl.Changelist");
  }

  virtual FText GetDisplayText() const override {
    const FString& Branch = Changelist.GetBranchName();
    FString Name = Changelist.IsNumbered()
      ? FString::Printf(TEXT("Changelist %d"), Changelist.GetId())
      : FString(TEXT("Default"));
    if (!Branch.IsEmpty()) {
      Name += FString::Printf(TEXT(" (%s)"), *Branch);
    }
    return FText::FromString(Name);
  }

  virtual FText GetDescriptionText() const override {
    return FText::FromString(Description);
  }

  virtual bool SupportsPersistentDescription() const override {
    // The daemon keeps a draft description for each branch's default
    // changelist too, so even the default one can be edited in place.
    return true;
  }

  virtual FText GetDisplayTooltip() const override {
    const FString& Branch = Changelist.GetBranchName();
    return FText::FromString(
      Branch.IsEmpty()
        ? FString(TEXT("Submits to the workspace's domain root"))
        : FString::Printf(TEXT("Submits to %s"), *Branch)
    );
  }

  virtual const FDateTime& GetTimeStamp() const override {
    return TimeStamp;
  }

  virtual const TArray<FSourceControlStateRef>
  GetFilesStates() const override {
    return Files;
  }

  virtual int32 GetFilesStatesNum() const override {
    return Files.Num();
  }

  virtual const TArray<FSourceControlStateRef>
  GetShelvedFilesStates() const override {
    return ShelvedFiles;
  }

  virtual int32 GetShelvedFilesStatesNum() const override {
    return ShelvedFiles.Num();
  }

  virtual FSourceControlChangelistRef
  GetChangelist() const override {
    return MakeShareable(
      new FCheckpointSourceControlChangelist(Changelist)
    );
  }

public:
  FCheckpointSourceControlChangelist Changelist;
  FString Description;
  FDateTime TimeStamp;
  TArray<FSourceControlStateRef> Files;
  TArray<FSourceControlStateRef> ShelvedFiles;
};
