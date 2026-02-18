// Copyright Incanta Games. All Rights Reserved.

#pragma once

#include "ISourceControlRevision.h"

class FCheckpointSourceControlProvider;

/**
 * Represents a single revision of a file in Checkpoint history.
 */
class FCheckpointSourceControlRevision final
  : public ISourceControlRevision {
public:
  FCheckpointSourceControlRevision()
    : RevisionNumber(0), FileSize(0), Provider(nullptr) {}

  /** Set provider reference (needed for Get() to access daemon client) */
  void SetProvider(FCheckpointSourceControlProvider* InProvider) {
    Provider = InProvider;
  }

  // ISourceControlRevision
  virtual bool Get(
    FString& InOutFilename,
    EConcurrency::Type InConcurrency =
      EConcurrency::Synchronous
  ) const override;

  virtual bool GetAnnotated(
    TArray<FAnnotationLine>& OutLines
  ) const override;

  virtual bool GetAnnotated(
    FString& InOutFilename
  ) const override;

  virtual const FString& GetFilename() const override {
    return Filename;
  }

  virtual int32 GetRevisionNumber() const override {
    return RevisionNumber;
  }

  virtual const FString& GetRevision() const override {
    return Revision;
  }

  virtual const FString& GetDescription() const override {
    return Description;
  }

  virtual const FString& GetUserName() const override {
    return UserName;
  }

  virtual const FString& GetClientSpec() const override {
    return ClientSpec;
  }

  virtual const FString& GetAction() const override {
    return Action;
  }

  virtual TSharedPtr<ISourceControlRevision, ESPMode::ThreadSafe>
  GetBranchSource() const override {
    return nullptr;
  }

  virtual const FDateTime& GetDate() const override {
    return Date;
  }

  virtual int32 GetCheckInIdentifier() const override {
    return RevisionNumber;
  }

  virtual int32 GetFileSize() const override {
    return FileSize;
  }

public:
  FString Filename;
  int32 RevisionNumber;
  FString Revision;
  FString Description;
  FString UserName;
  FString ClientSpec;
  FString Action;
  FDateTime Date;
  int32 FileSize;

  /** Provider reference for accessing daemon client. Not owned. */
  mutable FCheckpointSourceControlProvider* Provider;
};
