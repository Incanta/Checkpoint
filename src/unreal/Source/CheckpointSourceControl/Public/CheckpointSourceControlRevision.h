// Copyright (c) 2014-2023 Sebastien Rombauts (sebastien.rombauts@gmail.com)

#pragma once

#include "ISourceControlRevision.h"
#include "Misc/DateTime.h"
#include "Runtime/Launch/Resources/Version.h"

/** Revision of a file, linked to a specific commit */
class FCheckpointSourceControlRevision : public ISourceControlRevision {
public:
  /** ISourceControlRevision interface */
  virtual bool Get(
    FString &InOutFilename,
    EConcurrency::Type InConcurrency = EConcurrency::Synchronous
  ) const override;

  virtual bool GetAnnotated(TArray<FAnnotationLine> &OutLines) const override;
  virtual bool GetAnnotated(FString &InOutFilename) const override;
  virtual const FString &GetFilename() const override;
  virtual int32 GetRevisionNumber() const override;
  virtual const FString &GetRevision() const override;
  virtual const FString &GetDescription() const override;
  virtual const FString &GetUserName() const override;
  virtual const FString &GetClientSpec() const override;
  virtual const FString &GetAction() const override;
  virtual TSharedPtr<class ISourceControlRevision, ESPMode::ThreadSafe>
  GetBranchSource() const override;
  // virtual const FDateTime &GetDate() const override;
  virtual int32 GetCheckInIdentifier() const override;
  virtual int32 GetFileSize() const override;

public:
};

/** History composed of the last 100 revisions of the file */
typedef TArray<
  TSharedRef<FCheckpointSourceControlRevision, ESPMode::ThreadSafe>>
  TCheckpointSourceControlHistory;
