import { atom } from "jotai";
import { syncAtom } from "./store";

export interface User {
  daemonId: string;
  endpoint: string;
  auth?: {
    code: string;
  };
  details: null | {
    id: string;
    email: string;
    username: string;
    name: string | null;
  };
}

export const usersAtom = atom<User[] | null>(null);
syncAtom(usersAtom, "users");

export const currentUserAtom = atom<User | null>(null);
syncAtom(currentUserAtom, "currentUser");
