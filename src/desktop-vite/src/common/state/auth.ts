import { atom } from "jotai";
import { syncAtom } from "./store";

export interface Account {
  daemonId: string;
  endpoint: string;
  auth?: {
    code: string;
  };
  details: null | {
    id: string;
    email: string;
    username: string;
    name: string;
  };
}

export const accountsAtom = atom<Account[] | null>(null);
syncAtom(accountsAtom, "accounts");

export const authAccountAtom = atom<Account | null>(null);
syncAtom(authAccountAtom, "authAccount");
