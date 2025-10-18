import type { IpcMain, IpcMainEvent, WebContents } from "electron";

export type Channels = {
  "state:get": null;
  "atom:value": { key: string; value: any };
  "auth:login": { daemonId: string; endpoint: string };
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
