import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import { Directory } from "../common/state/workspace";

export type Channels = {
  "state:get": null;
  "atom:value": { key: string; value: any };

  "auth:login": { daemonId: string; endpoint: string };
  "auth:select-account": { daemonId: string };

  "workspace:select": { id: string };
  "workspace:create-branch": { name: string };
  "workspace:select-branch": { id: string };
  "workspace:get-directory": { path: string };
  "workspace:directory-contents": { path: string; directory: Directory };
  "workspace:configure": null;
  "workspace:refresh": null;
  "workspace:pull": null;
  "workspace:pull:files": { fileIds: string[] };
  "workspace:undo": null;
  "workspace:submit": { message: string; modifications: any; shelved: boolean };
  "workspace:diff:file": { path: string };
};

export function ipcSend<T extends keyof Channels>(
  sender: WebContents,
  channel: T,
  data: Channels[T],
): void {
  sender.send(channel, data);
}

export function ipcOn<T extends keyof Channels>(
  ipcMain: IpcMain,
  channel: T,
  callback: (event: IpcMainEvent, data: Channels[T]) => void,
): void {
  ipcMain.on(channel, (event, data: Channels[T]) => {
    callback(event, data);
  });
}
