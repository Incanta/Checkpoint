import { atom } from "jotai";
import { syncAtom } from "./store";
import { Org, Repo } from "@checkpointvcs/daemon";

export const dashboardOrgsAtom = atom<Org[]>([]);
syncAtom(dashboardOrgsAtom, "dashboardOrgs");

export const dashboardReposAtom = atom<Repo[]>([]);
syncAtom(dashboardReposAtom, "dashboardRepos");

export const dashboardNewWorkspaceFolderAtom = atom<string>("");
syncAtom(dashboardNewWorkspaceFolderAtom, "dashboardNewWorkspaceFolder");

export interface NewWorkspaceProgress {
  complete: boolean;
  error: string;
}

export const dashboardNewWorkspaceProgressAtom =
  atom<NewWorkspaceProgress | null>(null);
syncAtom(dashboardNewWorkspaceProgressAtom, "dashboardNewWorkspaceProgress");
