import { atom } from "jotai";
import { syncAtom } from "./store";

export interface Account {
  id: string;
  serverEndpoint: string;
  email: string;
  username: string;
  name: string;
}

export const accountsAtom = atom<Account[] | null>(null);
syncAtom(accountsAtom, "accounts");

export interface AuthAttempt {
  serverEndpoint: string;
  authCode: string | null;
  finished: boolean;
}

export const authAttemptAtom = atom<AuthAttempt | null>(null);
syncAtom(authAttemptAtom, "authAttempt");
