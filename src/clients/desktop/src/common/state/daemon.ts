import { atom } from "jotai";
import { syncAtom } from "./store";

// Tracks the desktop app's connection to the local Checkpoint daemon.
// "connecting" while the main process is (re)trying to reach the daemon,
// "connected" once it has answered. The main process keeps retrying while
// disconnected, so this flips back to "connected" automatically once the
// daemon comes up.
export type DaemonConnectionStatus = "connecting" | "connected";

export const daemonConnectionAtom = atom<DaemonConnectionStatus>("connecting");
syncAtom(daemonConnectionAtom, "daemonConnection");
