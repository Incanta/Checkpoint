import { atom } from "jotai";
import { syncAtom } from "./store";

export interface VersionCheckState {
  status: "compatible" | "warning" | "incompatible" | "unknown";
  message: string | null;
  dismissed: boolean;
}

export const versionCheckAtom = atom<VersionCheckState>({
  status: "unknown",
  message: null,
  dismissed: false,
});
syncAtom(versionCheckAtom, "versionCheckState");
