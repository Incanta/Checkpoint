import { atom } from "jotai";
import { syncAtom } from "./store";

/**
 * Delivery stream the daemon follows. Owned by the daemon
 * (~/.checkpoint/daemon.json); this copy is whatever its last status report
 * said, so the UI can show and change it.
 */
export type UpdateChannel = "release" | "nightly";

export interface UpdateState {
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  downloadProgress: number;
  errorMessage: string | null;
  dismissed: boolean;
  channel: UpdateChannel;
}

export const updateAtom = atom<UpdateState>({
  available: false,
  currentVersion: "0.0.0",
  latestVersion: null,
  status: "idle",
  downloadProgress: 0,
  errorMessage: null,
  dismissed: false,
  channel: "release",
});
syncAtom(updateAtom, "updateState");
