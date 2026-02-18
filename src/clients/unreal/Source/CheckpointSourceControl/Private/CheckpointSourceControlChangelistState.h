// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlChangelistState.h"

#include "CheckpointSourceControlChangelist.h"

/**
 * State for a Checkpoint changelist. Checkpoint doesn't use
 * P4-style changelists, so this is minimal.
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
    return FText::FromString(
      FString::Printf(
        TEXT("Changelist %s"),
        *Changelist.GetIdentifier()
      )
    );
  }

  virtual FText GetDescriptionText() const override {
    return FText::FromString(Description);
  }

  virtual bool SupportsPersistentDescription() const override {
    return false;
  }

  virtual FText GetDisplayTooltip() const override {
    return GetDisplayText();
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
