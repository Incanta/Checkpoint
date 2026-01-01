import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import { Directory, Modification } from "@checkpointvcs/daemon";

export type Channels = {
  "state:get": null;
  "atom:value": { key: string; value: any };

  "auth:login": { daemonId: string; endpoint: string };
  "auth:select-user": { daemonId: string };

  "set-renderer-url": { url: string };

  "workspace:create": {
    repoId: string;
    name: string;
    path: string;
    defaultBranchName: string;
  };
  "workspace:select": { id: string };
  "workspace:create-branch": { name: string };
  "workspace:select-branch": { name: string };
  "workspace:get-directory": { path: string };
  "workspace:directory-contents": { path: string; directory: Directory };
  "workspace:configure": null;
  "workspace:refresh": null;
  "workspace:history": null;
  "workspace:pull": { changelistId: number | null; filePaths: string[] | null };
  "workspace:revert": { filePaths: string[] };
  "workspace:submit": {
    message: string;
    modifications: Modification[];
    shelved: boolean;
  };
  "workspace:diff:file": { path: string };

  "dashboard:refresh": { daemonId: string | null; orgId: string | null };
  "dashboard:select-workspace-folder": null;
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
