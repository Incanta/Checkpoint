import { atom } from "jotai";
import { syncAtom } from "./store";
import type {
  Directory,
  Workspace,
  WorkspacePendingChanges,
  ApiTypes,
} from "@checkpointvcs/daemon/types";

export const workspacesAtom = atom<Workspace[] | null>(null);
syncAtom(workspacesAtom, "workspaces");

export const currentWorkspaceAtom = atom<Workspace | null>(null);
syncAtom(currentWorkspaceAtom, "currentWorkspace");

export const workspaceDirectoriesAtom = atom<Record<string, Directory>>({});
syncAtom(workspaceDirectoriesAtom, "workspaceDirectories");

export const workspacePendingChangesAtom = atom<WorkspacePendingChanges | null>(
  null,
);
syncAtom(workspacePendingChangesAtom, "workspacePendingChanges");

export const workspaceDiffAtom = atom<{ left: string; right: string } | null>(
  null,
);
syncAtom(workspaceDiffAtom, "workspaceDiff");

export const workspaceHistoryAtom = atom<ApiTypes.Changelist[] | null>(null);
syncAtom(workspaceHistoryAtom, "workspaceHistory");

// File history types
export interface FileHistoryEntry {
  changelistNumber: number;
  changeType: "ADD" | "DELETE" | "MODIFY";
  oldPath: string | null;
  changelist: {
    id: string;
    number: number;
    message: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string | null;
    user: {
      email: string;
      name: string | null;
      username: string | null;
    } | null;
  };
}

export interface FileHistoryState {
  filePath: string;
  entries: FileHistoryEntry[];
  selectedChangelistNumber: number | null;
  diffContent: { left: string; right: string } | null;
}

export const fileHistoryAtom = atom<FileHistoryState | null>(null);
syncAtom(fileHistoryAtom, "fileHistory");

// Changelist changes types (for viewing changes in a specific changelist)
export interface ChangelistFileChange {
  fileId: string;
  path: string;
  changeType: "ADD" | "DELETE" | "MODIFY";
  oldPath: string | null;
}

export interface ChangelistChangesState {
  changelistNumber: number;
  message: string;
  user: string;
  date: Date;
  files: ChangelistFileChange[];
  selectedFilePath: string | null;
  diffContent: { left: string; right: string } | null;
}

export const changelistChangesAtom = atom<ChangelistChangesState | null>(null);
syncAtom(changelistChangesAtom, "changelistChanges");

// Labels types
export interface LabelEntry {
  id: string;
  name: string;
  number: number;
  repoId: string;
  changelist: {
    number: number;
    message: string | null;
    createdAt: string;
    user: { email: string; name: string | null } | null;
  };
}

export const workspaceLabelsAtom = atom<LabelEntry[] | null>(null);
syncAtom(workspaceLabelsAtom, "workspaceLabels");
