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

export const authCodeAtom = atom<string | null>(null);
syncAtom(authCodeAtom, "authCode");
