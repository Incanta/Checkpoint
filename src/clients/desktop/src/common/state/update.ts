import { atom } from "jotai";
import { syncAtom } from "./store";

export interface UpdateState {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  downloadProgress: number;
  errorMessage: string | null;
  dismissed: boolean;
}

export const updateAtom = atom<UpdateState>({
  available: false,
  currentVersion: "0.0.0",
  latestVersion: null,
  status: "idle",
  downloadProgress: 0,
  errorMessage: null,
  dismissed: false,
});
syncAtom(updateAtom, "updateState");
