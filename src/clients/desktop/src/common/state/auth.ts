import { atom } from "jotai";
import { syncAtom } from "./store";

export interface User {
  daemonId: string;
  endpoint: string;
  /** The display name the user gave this account, if any. */
  label?: string | null;
  /** Whether the daemon reached the server on the last account check. */
  reachable?: boolean;
  auth?: {
    code: string;
    url: string;
  };
  details: null | {
    id: string;
    email: string;
    username: string | null;
    name: string | null;
    image: string | null;
  };
}

/** What to call an account in lists: its label, else username, else email. */
export function accountDisplayName(user: User): string {
  return (
    user.label ||
    user.details?.username ||
    user.details?.email ||
    user.endpoint ||
    "Unnamed account"
  );
}

export const usersAtom = atom<User[] | null>(null);
syncAtom(usersAtom, "users");

export const currentUserAtom = atom<User | null>(null);
syncAtom(currentUserAtom, "currentUser");

/**
 * A browser (device-code) sign-in that's in progress. Kept apart from
 * `currentUserAtom` so adding an account doesn't switch away from the active
 * one until the new account is actually authorized.
 */
export interface PendingLogin {
  daemonId: string;
  endpoint: string;
  /** Set once the daemon has a device code for the user to confirm. */
  code: string | null;
  url: string | null;
  /** Set when the sign-in failed; the flow is over at that point. */
  error: string | null;
}

export const pendingLoginAtom = atom<PendingLogin | null>(null);
syncAtom(pendingLoginAtom, "pendingLogin");
