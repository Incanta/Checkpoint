import { atom } from "jotai";
import { syncAtom } from "./store";
import { ApiTypes } from "@checkpointvcs/daemon";

export const dashboardOrgsAtom = atom<ApiTypes.Org[]>([]);
syncAtom(dashboardOrgsAtom, "dashboardOrgs");

export const dashboardReposAtom = atom<ApiTypes.Repo[]>([]);
syncAtom(dashboardReposAtom, "dashboardRepos");
