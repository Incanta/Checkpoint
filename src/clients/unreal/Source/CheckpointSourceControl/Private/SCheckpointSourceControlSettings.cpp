// Copyright Incanta Games. All Rights Reserved.

#if SOURCE_CONTROL_WITH_SLATE

  #include "SCheckpointSourceControlSettings.h"

  #include "CheckpointSourceControlProvider.h"
  #include "CheckpointSourceControlSettings.h"
  #include "Fonts/SlateFontInfo.h"
  #include "HAL/PlatformProcess.h"
  #include "Misc/Paths.h"
  #include "Styling/AppStyle.h"
  #include "Widgets/Input/SButton.h"
  #include "Widgets/Input/SEditableTextBox.h"
  #include "Widgets/Layout/SBorder.h"
  #include "Widgets/SBoxPanel.h"
  #include "Widgets/Text/STextBlock.h"

  #define LOCTEXT_NAMESPACE "CheckpointSourceControl"

const FString SCheckpointSourceControlSettings::LinkAccountSentinel =
  TEXT("Link account...");
const FString SCheckpointSourceControlSettings::CreateRepoSentinel =
  TEXT("Create repo...");

// ---------------------------------------------------------------
// Construct – choose between "connected" and "wizard" layout
// ---------------------------------------------------------------
void SCheckpointSourceControlSettings::Construct(
  const FArguments &InArgs, FCheckpointSourceControlProvider *InProvider
) {
  Provider = InProvider;
  SelectedAccountIndex = INDEX_NONE;
  SelectedOrgIndex = INDEX_NONE;
  SelectedRepoIndex = INDEX_NONE;
  bLinkingAccount = false;
  bCreatingRepo = false;
  ConnectEndpoint = TEXT("https://app.checkpoint.vcs");

  // Check whether workspace.json was found
  bWorkspaceDetected = GetProvider().AccessSettings().IsConfigured();

  // Default workspace path to project directory
  WorkspacePath = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
  FPaths::NormalizeDirectoryName(WorkspacePath);

  FSlateFontInfo Font =
    FAppStyle::GetFontStyle(TEXT("SourceControl.LoginWindow.Font"));

  if (bWorkspaceDetected) {
    // ---- Connected mode ----
    // clang-format off
    ChildSlot
    [
      SNew(SVerticalBox)
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 4.0f)
      [
        SNew(STextBlock)
        .Text(this,
          &SCheckpointSourceControlSettings::GetConnectionStatusText)
        .Font(Font)
      ]
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 4.0f)
      [
        SNew(STextBlock)
        .Text(LOCTEXT(
          "ConfiguredHint",
          "Workspace detected from .checkpoint/workspace.json. "
          "Press Accept Settings to reconnect."
        ))
        .Font(Font)
        .AutoWrapText(true)
      ]
    ];
    // clang-format on
  } else {
    // ---- Workspace creation wizard ----

    // Populate accounts immediately (daemon is hopefully running)
    RefreshAccounts();

    // clang-format off
    ChildSlot
    [
      SNew(SVerticalBox)

      // Info text
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 4.0f)
      [
        SNew(STextBlock)
        .Text(LOCTEXT(
          "NoWorkspaceHint",
          "No .checkpoint/workspace.json found above the project "
          "directory. Create a workspace below, or run the Checkpoint "
          "Desktop app to set one up."
        ))
        .Font(Font)
        .AutoWrapText(true)
      ]

      // ---- Account selector ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 6.0f, 2.0f, 2.0f)
      [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("AccountLabel", "Account"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(2.0f)
        [
          SAssignNew(AccountCombo,
            SComboBox<TSharedPtr<FString>>)
          .OptionsSource(&AccountNames)
          .OnGenerateWidget(this,
            &SCheckpointSourceControlSettings::MakeAccountItem)
          .OnSelectionChanged(this,
            &SCheckpointSourceControlSettings::OnAccountSelected)
          [
            SNew(STextBlock)
            .Text(this,
              &SCheckpointSourceControlSettings::GetSelectedAccountText)
            .Font(Font)
          ]
        ]
      ]

      // ---- Connect Account row (visible only when "Link account..." selected) ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f)
      [
        SNew(SHorizontalBox)
        .Visibility_Lambda([this]() {
          return bLinkingAccount
            ? EVisibility::Visible
            : EVisibility::Collapsed;
        })
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("EndpointLabel", "Server URL"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(1.5f)
        .Padding(2.0f, 0.0f)
        [
          SNew(SEditableTextBox)
          .Text_Lambda([this]() {
            return FText::FromString(ConnectEndpoint);
          })
          .OnTextCommitted_Lambda(
            [this](const FText& InText, ETextCommit::Type) {
              ConnectEndpoint = InText.ToString();
            })
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .AutoWidth()
        [
          SNew(SButton)
          .Text(LOCTEXT("ConnectBtn", "Connect Account"))
          .OnClicked(this,
            &SCheckpointSourceControlSettings::OnConnectAccountClicked)
        ]
      ]

      // ---- Organization selector ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f)
      [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("OrgLabel", "Organization"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(2.0f)
        [
          SAssignNew(OrgCombo,
            SComboBox<TSharedPtr<FString>>)
          .OptionsSource(&OrgNames)
          .OnGenerateWidget(this,
            &SCheckpointSourceControlSettings::MakeOrgItem)
          .OnSelectionChanged(this,
            &SCheckpointSourceControlSettings::OnOrgSelected)
          [
            SNew(STextBlock)
            .Text(this,
              &SCheckpointSourceControlSettings::GetSelectedOrgText)
            .Font(Font)
          ]
        ]
      ]

      // ---- Repository selector ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f)
      [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("RepoLabel", "Repository"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(2.0f)
        [
          SAssignNew(RepoCombo,
            SComboBox<TSharedPtr<FString>>)
          .OptionsSource(&RepoNames)
          .OnGenerateWidget(this,
            &SCheckpointSourceControlSettings::MakeRepoItem)
          .OnSelectionChanged(this,
            &SCheckpointSourceControlSettings::OnRepoSelected)
          [
            SNew(STextBlock)
            .Text(this,
              &SCheckpointSourceControlSettings::GetSelectedRepoText)
            .Font(Font)
          ]
        ]
      ]

      // ---- Create Repo row (visible only when "Create repo..." selected) ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f)
      [
        SNew(SHorizontalBox)
        .Visibility_Lambda([this]() {
          return bCreatingRepo
            ? EVisibility::Visible
            : EVisibility::Collapsed;
        })
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("NewRepoLabel", "New Repo Name"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(1.5f)
        .Padding(2.0f, 0.0f)
        [
          SNew(SEditableTextBox)
          .Text_Lambda([this]() {
            return FText::FromString(NewRepoName);
          })
          .OnTextCommitted_Lambda(
            [this](const FText& InText, ETextCommit::Type) {
              NewRepoName = InText.ToString();
            })
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .AutoWidth()
        [
          SNew(SButton)
          .Text(LOCTEXT("CreateRepoBtn", "Create Repo"))
          .OnClicked(this,
            &SCheckpointSourceControlSettings::OnCreateRepoClicked)
        ]
      ]

      // ---- Workspace Name ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 6.0f, 2.0f, 2.0f)
      [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("WsNameLabel", "Workspace Name"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(2.0f)
        [
          SNew(SEditableTextBox)
          .Text_Lambda([this]() {
            return FText::FromString(WorkspaceName);
          })
          .OnTextCommitted_Lambda(
            [this](const FText& InText, ETextCommit::Type) {
              WorkspaceName = InText.ToString();
            })
          .Font(Font)
        ]
      ]

      // ---- Workspace Root Path ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f)
      [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .FillWidth(1.0f)
        .VAlign(VAlign_Center)
        [
          SNew(STextBlock)
          .Text(LOCTEXT("WsPathLabel", "Workspace Root Path"))
          .Font(Font)
        ]
        + SHorizontalBox::Slot()
        .FillWidth(2.0f)
        [
          SNew(SEditableTextBox)
          .Text_Lambda([this]() {
            return FText::FromString(WorkspacePath);
          })
          .OnTextCommitted_Lambda(
            [this](const FText& InText, ETextCommit::Type) {
              WorkspacePath = InText.ToString();
            })
          .Font(Font)
        ]
      ]

      // ---- Create Workspace button ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 8.0f, 2.0f, 2.0f)
      [
        SNew(SButton)
        .Text(LOCTEXT("CreateWsBtn", "Create Workspace"))
        .HAlign(HAlign_Center)
        .OnClicked(this,
          &SCheckpointSourceControlSettings::OnCreateWorkspaceClicked)
      ]

      // ---- Status / feedback ----
      + SVerticalBox::Slot()
      .AutoHeight()
      .Padding(2.0f, 8.0f, 2.0f, 2.0f)
      [
        SNew(STextBlock)
        .Text(this,
          &SCheckpointSourceControlSettings::GetConnectionStatusText)
        .Font(Font)
        .AutoWrapText(true)
      ]
    ];
    // clang-format on
  }
}

// ---------------------------------------------------------------
// Status text
// ---------------------------------------------------------------
FText SCheckpointSourceControlSettings::GetConnectionStatusText() const {
  if (!StatusMessage.IsEmpty()) {
    return FText::FromString(StatusMessage);
  }
  return GetProvider().GetStatusText();
}

// ---------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------
void SCheckpointSourceControlSettings::RefreshAccounts() {
  Accounts.Empty();
  AccountNames.Empty();
  SelectedAccountName.Reset();
  SelectedAccountIndex = INDEX_NONE;

  // Read daemon port from daemon.json so we can talk to it
  FString HomeDir = FPlatformProcess::UserHomeDir();
  FString DaemonJsonPath =
    FPaths::Combine(HomeDir, TEXT(".checkpoint"), TEXT("daemon.json"));
  int32 Port = 3010;

  TSharedPtr<FJsonObject> DaemonJson =
    FCheckpointSourceControlSettings::ReadJsonFile(DaemonJsonPath);
  if (DaemonJson.IsValid()) {
    int32 P = 0;
    if (DaemonJson->TryGetNumberField(TEXT("daemonPort"), P) && P > 0 &&
        P < 65536) {
      Port = P;
    }
  }

  // Point daemon client at the discovered port
  FString Url = FString::Printf(TEXT("http://127.0.0.1:%d"), Port);
  GetProvider().GetDaemonClient().SetDaemonUrl(Url);

  TArray<TSharedPtr<FJsonValue>> Users;
  FString Error;
  if (!GetProvider().GetDaemonClient().GetUsers(Users, Error)) {
    StatusMessage = FString::Printf(TEXT("Could not reach daemon: %s"), *Error);
    return;
  }

  for (const auto &Val : Users) {
    const TSharedPtr<FJsonObject> *UserObj;
    if (!Val->TryGetObject(UserObj) || !UserObj->IsValid()) {
      continue;
    }

    FAccountInfo Info;
    (*UserObj)->TryGetStringField(TEXT("daemonId"), Info.DaemonId);
    (*UserObj)->TryGetStringField(TEXT("endpoint"), Info.Endpoint);

    FString Email;
    (*UserObj)->TryGetStringField(TEXT("email"), Email);
    FString Name;
    (*UserObj)->TryGetStringField(TEXT("name"), Name);

    Info.DisplayName = Name.IsEmpty()
      ? (Email.IsEmpty() ? Info.DaemonId : Email)
      : FString::Printf(TEXT("%s (%s)"), *Name, *Email);

    Accounts.Add(Info);
    AccountNames.Add(MakeShareable(new FString(Info.DisplayName)));
  }

  // Always append the "Link account..." sentinel at the end
  AccountNames.Add(MakeShareable(new FString(LinkAccountSentinel)));

  if (AccountCombo.IsValid()) {
    AccountCombo->RefreshOptions();
  }
}

void SCheckpointSourceControlSettings::RefreshOrgs() {
  Orgs.Empty();
  OrgNames.Empty();
  SelectedOrgName.Reset();
  SelectedOrgIndex = INDEX_NONE;

  // Also clear downstream
  Repos.Empty();
  RepoNames.Empty();
  SelectedRepoName.Reset();
  SelectedRepoIndex = INDEX_NONE;

  if (SelectedAccountIndex == INDEX_NONE ||
      !Accounts.IsValidIndex(SelectedAccountIndex)) {
    if (OrgCombo.IsValid()) OrgCombo->RefreshOptions();
    if (RepoCombo.IsValid()) RepoCombo->RefreshOptions();
    return;
  }

  const FString &DaemonId = Accounts[SelectedAccountIndex].DaemonId;

  TArray<TSharedPtr<FJsonValue>> OrgArr;
  FString Error;
  if (!GetProvider().GetDaemonClient().ListOrgs(DaemonId, OrgArr, Error)) {
    StatusMessage = FString::Printf(TEXT("Failed to list orgs: %s"), *Error);
    if (OrgCombo.IsValid()) OrgCombo->RefreshOptions();
    return;
  }

  for (const auto &Val : OrgArr) {
    const TSharedPtr<FJsonObject> *OrgObj;
    if (!Val->TryGetObject(OrgObj) || !OrgObj->IsValid()) {
      continue;
    }

    FOrgInfo Info;
    (*OrgObj)->TryGetStringField(TEXT("id"), Info.Id);
    (*OrgObj)->TryGetStringField(TEXT("name"), Info.Name);

    if (Info.Id.IsEmpty()) continue;

    Orgs.Add(Info);
    OrgNames.Add(
      MakeShareable(new FString(Info.Name.IsEmpty() ? Info.Id : Info.Name))
    );
  }

  if (OrgCombo.IsValid()) OrgCombo->RefreshOptions();
  if (RepoCombo.IsValid()) RepoCombo->RefreshOptions();
}

void SCheckpointSourceControlSettings::RefreshRepos() {
  Repos.Empty();
  RepoNames.Empty();
  SelectedRepoName.Reset();
  SelectedRepoIndex = INDEX_NONE;

  if (SelectedAccountIndex == INDEX_NONE || SelectedOrgIndex == INDEX_NONE ||
      !Accounts.IsValidIndex(SelectedAccountIndex) ||
      !Orgs.IsValidIndex(SelectedOrgIndex)) {
    if (RepoCombo.IsValid()) RepoCombo->RefreshOptions();
    return;
  }

  const FString &DaemonId = Accounts[SelectedAccountIndex].DaemonId;
  const FString &OrgId = Orgs[SelectedOrgIndex].Id;

  TArray<TSharedPtr<FJsonValue>> RepoArr;
  FString Error;
  if (!GetProvider().GetDaemonClient().ListRepos(
        DaemonId, OrgId, RepoArr, Error
      )) {
    StatusMessage = FString::Printf(TEXT("Failed to list repos: %s"), *Error);
    if (RepoCombo.IsValid()) RepoCombo->RefreshOptions();
    return;
  }

  for (const auto &Val : RepoArr) {
    const TSharedPtr<FJsonObject> *RepoObj;
    if (!Val->TryGetObject(RepoObj) || !RepoObj->IsValid()) {
      continue;
    }

    FRepoInfo Info;
    (*RepoObj)->TryGetStringField(TEXT("id"), Info.Id);
    (*RepoObj)->TryGetStringField(TEXT("name"), Info.Name);

    if (Info.Id.IsEmpty()) continue;

    Repos.Add(Info);
    RepoNames.Add(
      MakeShareable(new FString(Info.Name.IsEmpty() ? Info.Id : Info.Name))
    );
  }

  // Always append the "Create repo..." sentinel at the end
  RepoNames.Add(MakeShareable(new FString(CreateRepoSentinel)));

  if (RepoCombo.IsValid()) RepoCombo->RefreshOptions();
}

// ---------------------------------------------------------------
// Combo-box widget generators
// ---------------------------------------------------------------
TSharedRef<SWidget> SCheckpointSourceControlSettings::MakeAccountItem(
  TSharedPtr<FString> Item
) const {
  return SNew(STextBlock).Text(FText::FromString(*Item));
}

void SCheckpointSourceControlSettings::OnAccountSelected(
  TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo
) {
  SelectedAccountName = Item;
  StatusMessage.Empty();

  // Check if the "Link account..." sentinel was picked
  if (Item.IsValid() && *Item == LinkAccountSentinel) {
    bLinkingAccount = true;
    SelectedAccountIndex = INDEX_NONE;
    return; // Don't refresh orgs – user needs to complete login first
  }

  bLinkingAccount = false;
  SelectedAccountIndex = AccountNames.IndexOfByKey(Item);
  RefreshOrgs();
}

FText SCheckpointSourceControlSettings::GetSelectedAccountText() const {
  if (SelectedAccountName.IsValid()) {
    return FText::FromString(*SelectedAccountName);
  }
  return LOCTEXT("SelectAccount", "Select account...");
}

TSharedRef<SWidget> SCheckpointSourceControlSettings::MakeOrgItem(
  TSharedPtr<FString> Item
) const {
  return SNew(STextBlock).Text(FText::FromString(*Item));
}

void SCheckpointSourceControlSettings::OnOrgSelected(
  TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo
) {
  SelectedOrgName = Item;
  SelectedOrgIndex = OrgNames.IndexOfByKey(Item);
  StatusMessage.Empty();
  RefreshRepos();
}

FText SCheckpointSourceControlSettings::GetSelectedOrgText() const {
  if (SelectedOrgName.IsValid()) {
    return FText::FromString(*SelectedOrgName);
  }
  return LOCTEXT("SelectOrg", "Select organization...");
}

TSharedRef<SWidget> SCheckpointSourceControlSettings::MakeRepoItem(
  TSharedPtr<FString> Item
) const {
  return SNew(STextBlock).Text(FText::FromString(*Item));
}

void SCheckpointSourceControlSettings::OnRepoSelected(
  TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo
) {
  SelectedRepoName = Item;
  StatusMessage.Empty();

  // Check if the "Create repo..." sentinel was picked
  if (Item.IsValid() && *Item == CreateRepoSentinel) {
    bCreatingRepo = true;
    SelectedRepoIndex = INDEX_NONE;
    return;
  }

  bCreatingRepo = false;
  SelectedRepoIndex = RepoNames.IndexOfByKey(Item);
}

FText SCheckpointSourceControlSettings::GetSelectedRepoText() const {
  if (SelectedRepoName.IsValid()) {
    return FText::FromString(*SelectedRepoName);
  }
  return LOCTEXT("SelectRepo", "Select repository...");
}

// ---------------------------------------------------------------
// Actions
// ---------------------------------------------------------------
FReply SCheckpointSourceControlSettings::OnConnectAccountClicked() {
  if (ConnectEndpoint.IsEmpty()) {
    StatusMessage = TEXT("Please enter a server URL.");
    return FReply::Handled();
  }

  // Generate a stable daemonId from the endpoint
  FString DaemonId =
    FString::Printf(TEXT("ue-%s"), FPlatformProcess::ComputerName());

  FString Code, Url, Error;
  if (!GetProvider().GetDaemonClient().Login(
        ConnectEndpoint, DaemonId, Code, Url, Error
      )) {
    StatusMessage = FString::Printf(TEXT("Login failed: %s"), *Error);
    return FReply::Handled();
  }

  // Open the browser URL
  FPlatformProcess::LaunchURL(*Url, nullptr, nullptr);

  StatusMessage = FString::Printf(
    TEXT(
      "Opened browser. Enter code: %s\n"
      "After completing login, select your account "
      "from the Account dropdown (it may take a moment "
      "to appear)."
    ),
    *Code
  );

  // Refresh accounts after a short delay won't work well in Slate,
  // so we just tell the user to re-select.
  // They can also close/reopen the dialog which re-constructs.
  RefreshAccounts();

  return FReply::Handled();
}

FReply SCheckpointSourceControlSettings::OnCreateRepoClicked() {
  if (NewRepoName.IsEmpty()) {
    StatusMessage = TEXT("Please enter a name for the new repo.");
    return FReply::Handled();
  }
  if (SelectedAccountIndex == INDEX_NONE) {
    StatusMessage = TEXT("Please select an account first.");
    return FReply::Handled();
  }
  if (SelectedOrgIndex == INDEX_NONE) {
    StatusMessage = TEXT("Please select an organization first.");
    return FReply::Handled();
  }

  const FString &DaemonId = Accounts[SelectedAccountIndex].DaemonId;
  const FString &OrgId = Orgs[SelectedOrgIndex].Id;

  TSharedPtr<FJsonObject> RepoResult;
  FString Error;
  if (!GetProvider().GetDaemonClient().CreateRepo(
        DaemonId, OrgId, NewRepoName, RepoResult, Error
      )) {
    StatusMessage = FString::Printf(TEXT("Create repo failed: %s"), *Error);
    return FReply::Handled();
  }

  StatusMessage = FString::Printf(
    TEXT("Created repo '%s'. Refreshing list..."), *NewRepoName
  );
  NewRepoName.Empty();

  // Refresh repos so the new one appears
  RefreshRepos();

  return FReply::Handled();
}

FReply SCheckpointSourceControlSettings::OnCreateWorkspaceClicked() {
  if (SelectedAccountIndex == INDEX_NONE) {
    StatusMessage = TEXT("Please select an account.");
    return FReply::Handled();
  }
  if (SelectedOrgIndex == INDEX_NONE) {
    StatusMessage = TEXT("Please select an organization.");
    return FReply::Handled();
  }
  if (SelectedRepoIndex == INDEX_NONE) {
    StatusMessage = TEXT("Please select a repository.");
    return FReply::Handled();
  }
  if (WorkspaceName.IsEmpty()) {
    StatusMessage = TEXT("Please enter a workspace name.");
    return FReply::Handled();
  }
  if (WorkspacePath.IsEmpty()) {
    StatusMessage = TEXT("Please enter a workspace root path.");
    return FReply::Handled();
  }

  const FString &DaemonId = Accounts[SelectedAccountIndex].DaemonId;
  const FString &RepoId = Repos[SelectedRepoIndex].Id;

  TSharedPtr<FJsonObject> WsResult;
  FString Error;
  if (!GetProvider().GetDaemonClient().CreateWorkspace(
        DaemonId,
        RepoId,
        WorkspaceName,
        WorkspacePath,
        TEXT("main"),
        WsResult,
        Error
      )) {
    StatusMessage =
      FString::Printf(TEXT("Create workspace failed: %s"), *Error);
    return FReply::Handled();
  }

  StatusMessage = FString::Printf(
    TEXT(
      "Workspace '%s' created! Press Accept Settings "
      "to connect."
    ),
    *WorkspaceName
  );

  return FReply::Handled();
}

  #undef LOCTEXT_NAMESPACE

#endif // SOURCE_CONTROL_WITH_SLATE
