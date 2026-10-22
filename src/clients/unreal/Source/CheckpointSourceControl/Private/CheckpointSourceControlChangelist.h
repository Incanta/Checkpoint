// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlChangelist.h"

/**
 * A Checkpoint pending changelist: a workspace-local group of staged files
 * waiting to be submitted together, as in Perforce.
 *
 * Every branch the workspace can submit to has an unnumbered default
 * changelist, and the user can create numbered ones on top. They map onto
 * Unreal's model like this:
 *
 *  - The domain root's default changelist is Unreal's default changelist
 *    (IsDefault). It is the one an operation with no changelist targets.
 *  - A numbered changelist is an ordinary deletable changelist, keyed by its
 *    id. Its branch rides along so its files can be staged to the right place.
 *  - An overlay branch's default changelist is shown as a separate,
 *    undeletable changelist keyed by branch. Unreal allows only one default,
 *    and folding overlay work into it would submit that work to the domain
 *    root.
 *
 * The branch is stored empty for the domain root, so the daemon's own
 * default applies when it is sent and the domain root's default changelist
 * equals a default-constructed one.
 */
class FCheckpointSourceControlChangelist : public ISourceControlChangelist {
public:
  /** The domain root's default changelist. */
  FCheckpointSourceControlChangelist() : Id(INDEX_NONE) {}

  FCheckpointSourceControlChangelist(int32 InId, const FString &InBranchName) :
    Id(InId), BranchName(InBranchName) {}

  /** The default changelist of a branch; empty means the domain root. */
  static FCheckpointSourceControlChangelist DefaultFor(
    const FString &InBranchName
  ) {
    return FCheckpointSourceControlChangelist(INDEX_NONE, InBranchName);
  }

  // ISourceControlChangelist
  virtual bool CanDelete() const override {
    return IsNumbered();
  }

  virtual bool IsDefault() const override {
    return !IsNumbered() && BranchName.IsEmpty();
  }

  virtual FString GetIdentifier() const override {
    if (IsNumbered()) {
      return FString::FromInt(Id);
    }
    return BranchName.IsEmpty()
      ? FString(TEXT("default"))
      : FString::Printf(TEXT("default:%s"), *BranchName);
  }

  /** Whether this is a numbered changelist rather than a branch default. */
  bool IsNumbered() const {
    return Id >= 0;
  }

  /** The daemon's id for a numbered changelist, INDEX_NONE for a default. */
  int32 GetId() const {
    return Id;
  }

  /** The branch this changelist submits to; empty means the domain root. */
  const FString &GetBranchName() const {
    return BranchName;
  }

  bool operator==(const FCheckpointSourceControlChangelist &Other) const {
    // A numbered changelist never changes branch, so its id is enough. A
    // default one is identified by its branch alone.
    return IsNumbered()
      ? Id == Other.Id
      : !Other.IsNumbered() && BranchName == Other.BranchName;
  }

  bool operator!=(const FCheckpointSourceControlChangelist &Other) const {
    return !(*this == Other);
  }

  friend uint32 GetTypeHash(const FCheckpointSourceControlChangelist &CL) {
    return CL.IsNumbered()
      ? ::GetTypeHash(CL.Id)
      : HashCombine(::GetTypeHash(INDEX_NONE), ::GetTypeHash(CL.BranchName));
  }

private:
  int32 Id;
  FString BranchName;
};
