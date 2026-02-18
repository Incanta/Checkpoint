// Copyright Incanta Games. All Rights Reserved.

#pragma once

#if SOURCE_CONTROL_WITH_SLATE

  #include "Dom/JsonObject.h"
  #include "Widgets/DeclarativeSyntaxSupport.h"
  #include "Widgets/Input/SComboBox.h"
  #include "Widgets/SCompoundWidget.h"

class FCheckpointSourceControlProvider;

/**
 * Settings widget displayed in the Source Control login dialog.
 *
 * When a `.checkpoint/workspace.json` already exists above the project
 * directory the widget simply shows the connection status and pressing
 * Accept retries auto-detection.
 *
 * When no workspace.json is found it shows a workspace-creation wizard
 * with dropdown selectors for Account, Org, and Repo, plus a text field
 * for the workspace root path and name.
 */
class SCheckpointSourceControlSettings : public SCompoundWidget {
public:
  SLATE_BEGIN_ARGS(SCheckpointSourceControlSettings) {}
  SLATE_END_ARGS()

  void Construct(
    const FArguments &InArgs, FCheckpointSourceControlProvider *InProvider
  );

private:
  FCheckpointSourceControlProvider &GetProvider() const {
    return *Provider;
  }

  // --- Status helpers ---
  FText GetConnectionStatusText() const;

  // --- Wizard data fetching ---
  void RefreshAccounts();
  void RefreshOrgs();
  void RefreshRepos();

  // --- Combo-box callbacks ---
  TSharedRef<SWidget> MakeAccountItem(TSharedPtr<FString> Item) const;
  void OnAccountSelected(
    TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo
  );
  FText GetSelectedAccountText() const;

  TSharedRef<SWidget> MakeOrgItem(TSharedPtr<FString> Item) const;
  void OnOrgSelected(TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo);
  FText GetSelectedOrgText() const;

  TSharedRef<SWidget> MakeRepoItem(TSharedPtr<FString> Item) const;
  void OnRepoSelected(TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo);
  FText GetSelectedRepoText() const;

  // --- Actions ---
  FReply OnConnectAccountClicked();
  FReply OnCreateRepoClicked();
  FReply OnCreateWorkspaceClicked();

  // --- Data ---
  FCheckpointSourceControlProvider *Provider;

  /** Whether workspace.json was found (status-only mode) */
  bool bWorkspaceDetected;

  // Account list
  struct FAccountInfo {
    FString DaemonId;
    FString DisplayName;
    FString Endpoint;
  };
  TArray<FAccountInfo> Accounts;
  TArray<TSharedPtr<FString>> AccountNames;
  TSharedPtr<FString> SelectedAccountName;
  int32 SelectedAccountIndex;

  // Org list
  struct FOrgInfo {
    FString Id;
    FString Name;
  };
  TArray<FOrgInfo> Orgs;
  TArray<TSharedPtr<FString>> OrgNames;
  TSharedPtr<FString> SelectedOrgName;
  int32 SelectedOrgIndex;

  // Repo list
  struct FRepoInfo {
    FString Id;
    FString Name;
  };
  TArray<FRepoInfo> Repos;
  TArray<TSharedPtr<FString>> RepoNames;
  TSharedPtr<FString> SelectedRepoName;
  int32 SelectedRepoIndex;

  // Workspace creation fields
  FString WorkspaceName;
  FString WorkspacePath;

  // New repo name
  FString NewRepoName;

  // Connect account endpoint
  FString ConnectEndpoint;

  // Visibility flags driven by sentinel dropdown options
  bool bLinkingAccount;
  bool bCreatingRepo;

  // Sentinel display strings for special dropdown entries
  static const FString LinkAccountSentinel;
  static const FString CreateRepoSentinel;

  // Combo box widget refs (for forcing refresh)
  TSharedPtr<SComboBox<TSharedPtr<FString>>> AccountCombo;
  TSharedPtr<SComboBox<TSharedPtr<FString>>> OrgCombo;
  TSharedPtr<SComboBox<TSharedPtr<FString>>> RepoCombo;

  // Status / feedback text
  FString StatusMessage;
};

#endif // SOURCE_CONTROL_WITH_SLATE
