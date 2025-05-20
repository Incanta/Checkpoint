#pragma once

#include "CoreMinimal.h"
#include "ISourceControlState.h"

namespace ECheckpointState {
  enum Type {
    Unknown,
    NotInWorkspaceRoot,
    Local,
    Added,
    Deleted,
    Ignored,
    Cloaked,
    ReadOnlyControlled,
    WritableControlled,
    ChangedNotCheckedOut,
    ChangedCheckedOut,
    NotChangedCheckedOut,
    LockedCurrent,
    LockedOther,
    Artifact,
  }
}

class FCheckpointSourceControlState : public ISourceControlState {
public:
  FCheckpointSourceControlState(
    const FString &InFilename,
    ECheckpointState::Type InState = ECheckpointState::Unknown
  ) : Filename(InFilename), OldFilename(InFilename), State(InState) {
    // Constructor implementation
  }

public:
  FString Filename;
  FString OldFilename; // Different from Filename if the file was renamed

  ECheckpointState::Type State;
};
