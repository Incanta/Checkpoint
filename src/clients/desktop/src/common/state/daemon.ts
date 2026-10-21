import { atom } from "jotai";
import { syncAtom } from "./store";

// Tracks the desktop app's connection to the local Checkpoint daemon.
// "connecting" while the main process is first trying to reach the daemon,
// "connected" once it has answered, and "reconnecting" when an established
// connection was lost (the app stays on its current page and shows a banner).
// The main process keeps retrying while disconnected, so this flips back to
// "connected" automatically once the daemon comes up.
export type DaemonConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting";

export const daemonConnectionAtom = atom<DaemonConnectionStatus>("connecting");
syncAtom(daemonConnectionAtom, "daemonConnection");

// Whether the current account's remote Checkpoint server was reachable the
// last time we tried. The daemon can be up (daemonConnectionAtom === "connected")
// while the remote server is down; in that case we still route the app to the
// dashboard/workspace using cached data and surface a warning banner. Defaults
// to true so no banner flashes before the first check completes.
export const serverReachableAtom = atom<boolean>(true);
syncAtom(serverReachableAtom, "serverReachable");
