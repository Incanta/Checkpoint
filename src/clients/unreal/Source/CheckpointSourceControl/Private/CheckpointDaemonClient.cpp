// Copyright Incanta Games. All Rights Reserved.

#include "CheckpointDaemonClient.h"

#include "CheckpointSourceControlModule.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpManager.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

FCheckpointDaemonClient::FCheckpointDaemonClient() :
  DaemonUrl(TEXT("http://127.0.0.1:3010")) {}

void FCheckpointDaemonClient::SetDaemonUrl(const FString &InUrl) {
  DaemonUrl = InUrl;
}

FString FCheckpointDaemonClient::JsonToString(
  const TSharedPtr<FJsonObject> &JsonObj
) {
  FString Output;
  auto Writer =
    TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output
    );
  FJsonSerializer::Serialize(JsonObj.ToSharedRef(), Writer);
  return Output;
}

FString FCheckpointDaemonClient::BuildQueryUrl(
  const FString &ProcedurePath, const TSharedPtr<FJsonObject> &Input
) {
  FString Url = DaemonUrl / ProcedurePath;
  if (Input.IsValid()) {
    TSharedPtr<FJsonObject> Wrapped = MakeShareable(new FJsonObject());
    Wrapped->SetObjectField(TEXT("json"), Input);
    FString InputJson = JsonToString(Wrapped);
    Url += TEXT("?input=") + FGenericPlatformHttp::UrlEncode(InputJson);
  }
  return Url;
}

FString FCheckpointDaemonClient::BuildMutationBody(
  const TSharedPtr<FJsonObject> &Input
) {
  TSharedPtr<FJsonObject> Wrapped = MakeShareable(new FJsonObject());
  if (Input.IsValid()) {
    Wrapped->SetObjectField(TEXT("json"), Input);
  } else {
    Wrapped->SetObjectField(TEXT("json"), MakeShareable(new FJsonObject()));
  }
  return JsonToString(Wrapped);
}

bool FCheckpointDaemonClient::ParseTrpcResponse(
  const FString &ResponseBody,
  TSharedPtr<FJsonObject> &OutData,
  FString &OutError
) {
  TSharedPtr<FJsonObject> ResponseJson;
  auto Reader = TJsonReaderFactory<>::Create(ResponseBody);
  if (!FJsonSerializer::Deserialize(Reader, ResponseJson) ||
      !ResponseJson.IsValid()) {
    OutError = TEXT("Failed to parse JSON response from daemon");
    return false;
  }

  // Check for tRPC error
  const TSharedPtr<FJsonObject> *ErrorObj;
  if (ResponseJson->TryGetObjectField(TEXT("error"), ErrorObj)) {
    // Try to get nested json.message for superjson format
    const TSharedPtr<FJsonObject> *ErrorJsonObj;
    if ((*ErrorObj)->TryGetObjectField(TEXT("json"), ErrorJsonObj)) {
      (*ErrorJsonObj)->TryGetStringField(TEXT("message"), OutError);
    }
    if (OutError.IsEmpty()) {
      (*ErrorObj)->TryGetStringField(TEXT("message"), OutError);
    }
    if (OutError.IsEmpty()) {
      OutError = TEXT("Unknown daemon error");
    }
    return false;
  }

  // Extract result.data.json
  const TSharedPtr<FJsonObject> *ResultObj;
  if (ResponseJson->TryGetObjectField(TEXT("result"), ResultObj)) {
    const TSharedPtr<FJsonObject> *DataObj;
    if ((*ResultObj)->TryGetObjectField(TEXT("data"), DataObj)) {
      const TSharedPtr<FJsonObject> *JsonObj;
      if ((*DataObj)->TryGetObjectField(TEXT("json"), JsonObj)) {
        OutData = *JsonObj;
        return true;
      }
      // Some endpoints may return data directly without json wrapper
      OutData = *DataObj;
      return true;
    }
  }

  OutError = TEXT("Unexpected response format from daemon");
  return false;
}

bool FCheckpointDaemonClient::DoHttpRequest(
  const FString &Verb,
  const FString &Url,
  const FString &Body,
  FString &OutResponse,
  int32 &OutResponseCode
) {
  TSharedRef<IHttpRequest, ESPMode::ThreadSafe> HttpRequest =
    FHttpModule::Get().CreateRequest();
  HttpRequest->SetURL(Url);
  HttpRequest->SetVerb(Verb);
  HttpRequest->SetHeader(TEXT("Content-Type"), TEXT("application/json"));

  if (!Body.IsEmpty()) {
    HttpRequest->SetContentAsString(Body);
  }

  TAtomic<bool> bCompleted(false);
  FString ResponseBody;
  int32 ResponseCode = 0;

  HttpRequest->OnProcessRequestComplete().BindLambda(
    [&bCompleted, &ResponseBody, &ResponseCode](
      FHttpRequestPtr, FHttpResponsePtr Response, bool bConnectedSuccessfully
    ) {
      if (bConnectedSuccessfully && Response.IsValid()) {
        ResponseBody = Response->GetContentAsString();
        ResponseCode = Response->GetResponseCode();
      } else {
        ResponseCode = 0;
      }
      bCompleted = true;
    }
  );

  HttpRequest->ProcessRequest();

  // Block until the request completes
  const double TimeoutSeconds = 30.0;
  const double StartTime = FPlatformTime::Seconds();
  while (!bCompleted) {
    if (IsInGameThread()) {
      FHttpModule::Get().GetHttpManager().Tick(0.01f);
    }
    FPlatformProcess::Sleep(0.01f);
    if (FPlatformTime::Seconds() - StartTime > TimeoutSeconds) {
      HttpRequest->CancelRequest();
      UE_LOG(
        LogCheckpointSourceControl,
        Warning,
        TEXT("HTTP request timed out: %s"),
        *Url
      );
      OutResponseCode = 0;
      return false;
    }
  }

  OutResponse = ResponseBody;
  OutResponseCode = ResponseCode;
  return ResponseCode >= 200 && ResponseCode < 300;
}

bool FCheckpointDaemonClient::QueryProcedure(
  const FString &Path,
  const TSharedPtr<FJsonObject> &Input,
  TSharedPtr<FJsonObject> &OutResult,
  FString &OutError
) {
  FString Url = BuildQueryUrl(Path, Input);
  FString ResponseBody;
  int32 ResponseCode = 0;

  if (!DoHttpRequest(TEXT("GET"), Url, FString(), ResponseBody, ResponseCode)) {
    if (ResponseBody.IsEmpty()) {
      OutError = FString::Printf(
        TEXT("Failed to connect to Checkpoint daemon at %s (HTTP %d)"),
        *DaemonUrl,
        ResponseCode
      );
    } else {
      // Try to parse error from response
      ParseTrpcResponse(ResponseBody, OutResult, OutError);
    }
    return false;
  }

  return ParseTrpcResponse(ResponseBody, OutResult, OutError);
}

bool FCheckpointDaemonClient::MutateProcedure(
  const FString &Path,
  const TSharedPtr<FJsonObject> &Input,
  TSharedPtr<FJsonObject> &OutResult,
  FString &OutError
) {
  FString Url = DaemonUrl / Path;
  FString Body = BuildMutationBody(Input);
  FString ResponseBody;
  int32 ResponseCode = 0;

  if (!DoHttpRequest(TEXT("POST"), Url, Body, ResponseBody, ResponseCode)) {
    if (ResponseBody.IsEmpty()) {
      OutError = FString::Printf(
        TEXT("Failed to connect to Checkpoint daemon at %s (HTTP %d)"),
        *DaemonUrl,
        ResponseCode
      );
    } else {
      ParseTrpcResponse(ResponseBody, OutResult, OutError);
    }
    return false;
  }

  return ParseTrpcResponse(ResponseBody, OutResult, OutError);
}

// ---- High-level API methods ----

bool FCheckpointDaemonClient::GetUsers(
  TArray<TSharedPtr<FJsonValue>> &OutUsers, FString &OutError
) {
  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("auth.getUsers"), nullptr, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *UsersArray;
    if (Result->TryGetArrayField(TEXT("users"), UsersArray)) {
      OutUsers = *UsersArray;
      return true;
    }
  }

  OutError = TEXT("Unexpected response format for getUsers");
  return false;
}

bool FCheckpointDaemonClient::GetUser(
  const FString &DaemonId, TSharedPtr<FJsonObject> &OutUser, FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("auth.getUser"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TSharedPtr<FJsonObject> *UserObj;
    if (Result->TryGetObjectField(TEXT("user"), UserObj)) {
      OutUser = *UserObj;
      return true;
    }
  }

  OutError = TEXT("Unexpected response format for getUser");
  return false;
}

bool FCheckpointDaemonClient::GetLocalWorkspaces(
  const FString &DaemonId,
  TArray<TSharedPtr<FJsonValue>> &OutWorkspaces,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("workspaces.list.local"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *WsArray;
    if (Result->TryGetArrayField(TEXT("workspaces"), WsArray)) {
      OutWorkspaces = *WsArray;
      return true;
    }
  }

  OutError = TEXT("Unexpected response format for list.local");
  return false;
}

bool FCheckpointDaemonClient::GetDirectory(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &RelPath,
  TSharedPtr<FJsonObject> &OutDirectory,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("path"), RelPath);

  return QueryProcedure(
    TEXT("workspaces.getDirectory"), Input, OutDirectory, OutError
  );
}

bool FCheckpointDaemonClient::GetActiveCheckouts(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const TArray<FString> &RelPaths,
  TArray<TSharedPtr<FJsonValue>> &OutCheckouts,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TArray<TSharedPtr<FJsonValue>> PathsArray;
  for (const FString &Path : RelPaths) {
    PathsArray.Add(MakeShareable(new FJsonValueString(Path)));
  }
  Input->SetArrayField(TEXT("filePaths"), PathsArray);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(
        TEXT("workspaces.getActiveCheckoutsForFiles"), Input, Result, OutError
      )) {
    return false;
  }

  // The result itself may be the array or wrapped
  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *CheckoutsArray;
    if (Result->TryGetArrayField(TEXT("checkouts"), CheckoutsArray)) {
      OutCheckouts = *CheckoutsArray;
      return true;
    }
  }

  // If the top-level result is the array, it won't be in OutResult
  // Handle gracefully
  OutCheckouts.Empty();
  return true;
}

bool FCheckpointDaemonClient::Checkout(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &RelPath,
  bool bLocked,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("path"), RelPath);
  Input->SetBoolField(TEXT("locked"), bLocked);

  TSharedPtr<FJsonObject> Result;
  return MutateProcedure(TEXT("workspaces.checkout"), Input, Result, OutError);
}

bool FCheckpointDaemonClient::UndoCheckout(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &RelPath,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("path"), RelPath);

  TSharedPtr<FJsonObject> Result;
  return MutateProcedure(
    TEXT("workspaces.undoCheckout"), Input, Result, OutError
  );
}

bool FCheckpointDaemonClient::Submit(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &Message,
  const TArray<TSharedPtr<FJsonValue>> &Modifications,
  bool bShelved,
  bool bKeepCheckedOut,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("message"), Message);
  Input->SetArrayField(TEXT("modifications"), Modifications);
  Input->SetBoolField(TEXT("shelved"), bShelved);
  Input->SetBoolField(TEXT("keepCheckedOut"), bKeepCheckedOut);

  TSharedPtr<FJsonObject> Result;
  // submit is implemented as a query in the daemon
  return QueryProcedure(TEXT("workspaces.submit"), Input, Result, OutError);
}

bool FCheckpointDaemonClient::Pull(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const TArray<FString> *FilePaths,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetField(TEXT("changelistId"), MakeShareable(new FJsonValueNull()));

  if (FilePaths && FilePaths->Num() > 0) {
    TArray<TSharedPtr<FJsonValue>> PathsArray;
    for (const FString &Path : *FilePaths) {
      PathsArray.Add(MakeShareable(new FJsonValueString(Path)));
    }
    Input->SetArrayField(TEXT("filePaths"), PathsArray);
  } else {
    Input->SetField(TEXT("filePaths"), MakeShareable(new FJsonValueNull()));
  }

  TSharedPtr<FJsonObject> Result;
  // pull is implemented as a query in the daemon
  return QueryProcedure(TEXT("workspaces.pull"), Input, Result, OutError);
}

bool FCheckpointDaemonClient::GetHistory(
  const FString &DaemonId,
  const FString &WorkspaceId,
  TArray<TSharedPtr<FJsonValue>> &OutHistory,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("workspaces.history"), Input, Result, OutError)) {
    return false;
  }

  // The history endpoint returns an array directly
  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *HistArray;
    if (Result->TryGetArrayField(TEXT("history"), HistArray)) {
      OutHistory = *HistArray;
      return true;
    }
  }

  OutHistory.Empty();
  return true;
}

bool FCheckpointDaemonClient::GetFileHistory(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &RelPath,
  TArray<TSharedPtr<FJsonValue>> &OutHistory,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("filePath"), RelPath);
  Input->SetNumberField(TEXT("count"), 50);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(
        TEXT("workspaces.fileHistory"), Input, Result, OutError
      )) {
    return false;
  }

  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *HistArray;
    if (Result->TryGetArrayField(TEXT("history"), HistArray)) {
      OutHistory = *HistArray;
      return true;
    }
  }

  OutHistory.Empty();
  return true;
}

bool FCheckpointDaemonClient::DiffFile(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &RelPath,
  FString &OutLeft,
  FString &OutRight,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("path"), RelPath);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("workspaces.diffFile"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    Result->TryGetStringField(TEXT("left"), OutLeft);
    Result->TryGetStringField(TEXT("right"), OutRight);
    return true;
  }

  OutError = TEXT("Unexpected response format for diffFile");
  return false;
}

bool FCheckpointDaemonClient::RefreshWorkspace(
  const FString &DaemonId, const FString &WorkspaceId, FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TSharedPtr<FJsonObject> Result;
  return QueryProcedure(TEXT("workspaces.refresh"), Input, Result, OutError);
}

bool FCheckpointDaemonClient::GetPendingChanges(
  const FString &DaemonId,
  const FString &WorkspaceId,
  TMap<FString, int32> &OutFileStatuses,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("workspaces.refresh"), Input, Result, OutError)) {
    return false;
  }

  if (!Result.IsValid()) {
    OutError = TEXT("Unexpected response format for refresh");
    return false;
  }

  // Parse the files map from the response: { files: { [relPath]: { status } } }
  const TSharedPtr<FJsonObject> *FilesObj;
  if (Result->TryGetObjectField(TEXT("files"), FilesObj)) {
    for (const auto &Pair : (*FilesObj)->Values) {
      const TSharedPtr<FJsonObject> *FileObj;
      if (Pair.Value->TryGetObject(FileObj)) {
        int32 Status = 0;
        (*FileObj)->TryGetNumberField(TEXT("status"), Status);
        OutFileStatuses.Add(Pair.Key, Status);
      }
    }
  }

  return true;
}

bool FCheckpointDaemonClient::GetFileAtChangelist(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const FString &RelPath,
  int32 ChangelistNumber,
  FString &OutCachePath,
  bool &bOutIsBinary,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);
  Input->SetStringField(TEXT("filePath"), RelPath);
  Input->SetNumberField(TEXT("changelistNumber"), ChangelistNumber);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(
        TEXT("workspaces.readFileAtChangelist"), Input, Result, OutError
      )) {
    return false;
  }

  if (!Result.IsValid()) {
    OutError = TEXT("Unexpected response format for readFileAtChangelist");
    return false;
  }

  Result->TryGetStringField(TEXT("cachePath"), OutCachePath);
  Result->TryGetBoolField(TEXT("isBinary"), bOutIsBinary);
  return true;
}

bool FCheckpointDaemonClient::RevertFiles(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const TArray<FString> &RelPaths,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TArray<TSharedPtr<FJsonValue>> PathsArray;
  for (const FString &RelPath : RelPaths) {
    PathsArray.Add(MakeShareable(new FJsonValueString(RelPath)));
  }
  Input->SetArrayField(TEXT("filePaths"), PathsArray);

  TSharedPtr<FJsonObject> Result;
  return MutateProcedure(
    TEXT("workspaces.revertFiles"), Input, Result, OutError
  );
}

bool FCheckpointDaemonClient::MarkForAdd(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const TArray<FString> &RelPaths,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TArray<TSharedPtr<FJsonValue>> PathsArray;
  for (const FString &RelPath : RelPaths) {
    PathsArray.Add(MakeShareable(new FJsonValueString(RelPath)));
  }
  Input->SetArrayField(TEXT("paths"), PathsArray);

  TSharedPtr<FJsonObject> Result;
  return MutateProcedure(
    TEXT("workspaces.markForAdd"), Input, Result, OutError
  );
}

bool FCheckpointDaemonClient::UnmarkForAdd(
  const FString &DaemonId,
  const FString &WorkspaceId,
  const TArray<FString> &RelPaths,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("workspaceId"), WorkspaceId);

  TArray<TSharedPtr<FJsonValue>> PathsArray;
  for (const FString &RelPath : RelPaths) {
    PathsArray.Add(MakeShareable(new FJsonValueString(RelPath)));
  }
  Input->SetArrayField(TEXT("paths"), PathsArray);

  TSharedPtr<FJsonObject> Result;
  return MutateProcedure(
    TEXT("workspaces.unmarkForAdd"), Input, Result, OutError
  );
}

// ---- Settings / Workspace-creation API ----

bool FCheckpointDaemonClient::Login(
  const FString &Endpoint,
  const FString &DaemonId,
  FString &OutCode,
  FString &OutUrl,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("endpoint"), Endpoint);
  Input->SetStringField(TEXT("daemonId"), DaemonId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("auth.login"), Input, Result, OutError)) {
    return false;
  }

  if (!Result.IsValid()) {
    OutError = TEXT("Unexpected response from auth.login");
    return false;
  }

  Result->TryGetStringField(TEXT("code"), OutCode);
  Result->TryGetStringField(TEXT("url"), OutUrl);
  return true;
}

bool FCheckpointDaemonClient::ListOrgs(
  const FString &DaemonId,
  TArray<TSharedPtr<FJsonValue>> &OutOrgs,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("orgs.list"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *Arr;
    if (Result->TryGetArrayField(TEXT("orgs"), Arr)) {
      OutOrgs = *Arr;
    }
  }
  return true;
}

bool FCheckpointDaemonClient::ListRepos(
  const FString &DaemonId,
  const FString &OrgId,
  TArray<TSharedPtr<FJsonValue>> &OutRepos,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("orgId"), OrgId);

  TSharedPtr<FJsonObject> Result;
  if (!QueryProcedure(TEXT("repos.list"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TArray<TSharedPtr<FJsonValue>> *Arr;
    if (Result->TryGetArrayField(TEXT("repos"), Arr)) {
      OutRepos = *Arr;
    }
  }
  return true;
}

bool FCheckpointDaemonClient::CreateRepo(
  const FString &DaemonId,
  const FString &OrgId,
  const FString &RepoName,
  TSharedPtr<FJsonObject> &OutRepo,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("orgId"), OrgId);
  Input->SetStringField(TEXT("name"), RepoName);

  TSharedPtr<FJsonObject> Result;
  if (!MutateProcedure(TEXT("repos.create"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TSharedPtr<FJsonObject> *RepoObj;
    if (Result->TryGetObjectField(TEXT("repo"), RepoObj)) {
      OutRepo = *RepoObj;
    }
  }
  return true;
}

bool FCheckpointDaemonClient::CreateWorkspace(
  const FString &DaemonId,
  const FString &RepoId,
  const FString &Name,
  const FString &LocalPath,
  const FString &DefaultBranchName,
  TSharedPtr<FJsonObject> &OutWorkspace,
  FString &OutError
) {
  TSharedPtr<FJsonObject> Input = MakeShareable(new FJsonObject());
  Input->SetStringField(TEXT("daemonId"), DaemonId);
  Input->SetStringField(TEXT("repoId"), RepoId);
  Input->SetStringField(TEXT("name"), Name);
  Input->SetStringField(TEXT("path"), LocalPath);
  Input->SetStringField(TEXT("defaultBranchName"), DefaultBranchName);

  TSharedPtr<FJsonObject> Result;
  if (!MutateProcedure(TEXT("workspaces.create"), Input, Result, OutError)) {
    return false;
  }

  if (Result.IsValid()) {
    const TSharedPtr<FJsonObject> *WsObj;
    if (Result->TryGetObjectField(TEXT("workspace"), WsObj)) {
      OutWorkspace = *WsObj;
    }
  }
  return true;
}
