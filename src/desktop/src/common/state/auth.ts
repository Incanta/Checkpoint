import { atom } from "jotai";
import { syncAtom } from "./store";

export interface User {
  daemonId: string;
  endpoint: string;
  auth?: {
    code: string;
    url: string;
  };
  details: null | {
    id: string;
    email: string;
    username: string | null;
    name: string | null;
  };
}

export const usersAtom = atom<User[] | null>(null);
syncAtom(usersAtom, "users");

export const currentUserAtom = atom<User | null>(null);
syncAtom(currentUserAtom, "currentUser");
