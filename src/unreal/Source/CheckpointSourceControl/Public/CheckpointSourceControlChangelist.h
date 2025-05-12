#pragma once

#include "CheckpointMacros.h"
#include "Runtime/Launch/Resources/Version.h"

#include "ISourceControlChangelist.h"

class FCheckpointSourceControlChangelist : public ISourceControlChangelist {
public:
  FCheckpointSourceControlChangelist() = default;

  explicit FCheckpointSourceControlChangelist(
    FString &&InChangelistName, const bool bInInitialized = false
  ) :
    ChangelistName(MoveTemp(InChangelistName)), bInitialized(bInInitialized) {}

  virtual bool CanDelete() const override {
    return false;
  }

  bool operator==(const FCheckpointSourceControlChangelist &InOther) const {
    return ChangelistName == InOther.ChangelistName;
  }

  bool operator!=(const FCheckpointSourceControlChangelist &InOther) const {
    return ChangelistName != InOther.ChangelistName;
  }

#if StartingInVersion(5, 3)
  virtual bool IsDefault() const override {
    return false;
  }
#endif

  void SetInitialized() {
    bInitialized = true;
  }

  bool IsInitialized() const {
    return bInitialized;
  }

  void Reset() {
    ChangelistName.Reset();
    bInitialized = false;
  }

  friend FORCEINLINE uint32
  GetTypeHash(const FCheckpointSourceControlChangelist &InChangelist) {
    return GetTypeHash(InChangelist.ChangelistName);
  }

  FString GetName() const {
    return ChangelistName;
  }

#if StartingInVersion(5, 3)
  virtual FString GetIdentifier() const override {
    return ChangelistName;
  }
#endif

public:
private:
  FString ChangelistName;
  bool bInitialized = false;
};

typedef TSharedRef<
  class FCheckpointSourceControlChangelist,
  ESPMode::ThreadSafe>
  FCheckpointSourceControlChangelistRef;
