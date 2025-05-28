#pragma once

#include <string>

#include "types.h"

#ifdef _WIN32
#define DLL_EXPORT extern "C" __declspec(dllexport)
#else
#define DLL_EXPORT extern "C"
#endif

#define NO_BLOCKS_ERROR 10100

namespace Checkpoint {

DLL_EXPORT WhoamiResult* Whoami();
DLL_EXPORT ErrorResult* Login();
DLL_EXPORT WorkspaceResult* GetWorkspaceDetails(const char* path);
DLL_EXPORT ErrorResult* SaveWorkspaceDetails(Workspace* workspace);
DLL_EXPORT WorkspaceStateResult* GetWorkspaceState(const char* localRoot);
DLL_EXPORT ErrorResult* SaveWorkspaceState(const char* localRoot, WorkspaceState* state);
DLL_EXPORT ErrorResult* Submit(
    Workspace* workspace,
    const char* message,
    bool keepCheckedOut,
    const char* workspaceId,
    size_t numModifications,
    Modification* modifications);
DLL_EXPORT ErrorResult* Pull(Workspace* workspace, const char* changelistId);
DLL_EXPORT ErrorResult* Add(Workspace* workspace, size_t numFiles, const char* paths);
DLL_EXPORT ErrorResult* Checkout(Workspace* workspace, size_t numFiles, const char* paths, bool* isLocked);

DLL_EXPORT bool TryAcquireLock(Workspace* workspace);
DLL_EXPORT bool AcquireLock(Workspace* workspace);
DLL_EXPORT void ReleaseLock(Workspace* workspace);

DLL_EXPORT void FreeWhoami(WhoamiResult* result);
DLL_EXPORT void FreeError(ErrorResult* result);
DLL_EXPORT void FreeWorkspace(WorkspaceResult* result);
DLL_EXPORT void FreeWorkspaceState(WorkspaceStateResult* result);

}  // namespace Checkpoint
