import { atom } from "jotai";
import { syncAtom } from "./store";
import {
  Directory,
  Workspace,
  WorkspacePendingChanges,
} from "@checkpointvcs/daemon";

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
