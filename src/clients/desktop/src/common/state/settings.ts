import { atom } from "jotai";
import { syncAtom } from "./store";

export interface UserSettings {
  /** Use backslashes for path separators when copying paths (Windows style) */
  useBackslashes: boolean;
}

const defaultSettings: UserSettings = {
  useBackslashes: false,
};

export const userSettingsAtom = atom<UserSettings>(defaultSettings);
syncAtom(userSettingsAtom, "userSettings");
