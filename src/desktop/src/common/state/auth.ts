import { atom } from "jotai";
import { syncAtom } from "./store";

export interface Account {
  id: string;
  email: string;
  name: string;
}

export const accountsAtom = atom<Account[] | null>(null);
syncAtom(accountsAtom, "accounts");

export const authCodeAtom = atom<string | null>(null);
syncAtom(authCodeAtom, "authCode");
