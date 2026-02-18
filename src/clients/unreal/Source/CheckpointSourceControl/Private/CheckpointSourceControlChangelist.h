// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlChangelist.h"

/**
 * Represents a Checkpoint changelist (version/commit number).
 * Checkpoint changelists are sequential numbered versions, not
 * Perforce-style pending change groups.
 */
class FCheckpointSourceControlChangelist
  : public ISourceControlChangelist {
public:
  FCheckpointSourceControlChangelist() : Number(-1) {}

  explicit FCheckpointSourceControlChangelist(int32 InNumber)
    : Number(InNumber) {}

  // ISourceControlChangelist
  virtual bool CanDelete() const override { return false; }
  virtual bool IsDefault() const override { return Number < 0; }

  virtual FString GetIdentifier() const override {
    return Number >= 0
      ? FString::FromInt(Number)
      : TEXT("default");
  }

  int32 GetNumber() const { return Number; }

  bool operator==(
    const FCheckpointSourceControlChangelist& Other
  ) const {
    return Number == Other.Number;
  }

  bool operator!=(
    const FCheckpointSourceControlChangelist& Other
  ) const {
    return Number != Other.Number;
  }

  friend uint32 GetTypeHash(
    const FCheckpointSourceControlChangelist& CL
  ) {
    return ::GetTypeHash(CL.Number);
  }

private:
  int32 Number;
};
