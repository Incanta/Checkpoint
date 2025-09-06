// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

export type Channels = "auth:login" | "auth:getUser" | "atom:value";

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]): void {
      ipcRenderer.send(channel, ...args);
    },

    on(channel: Channels, func: (...args: unknown[]) => void): () => void {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return (): void => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },

    once(channel: Channels, func: (...args: unknown[]) => void): void {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
  },
  auth: {
    login: (): Promise<{ success: boolean; code?: string; error?: string }> =>
      ipcRenderer.invoke("auth:login"),

    getUser: (): Promise<{ success: boolean; user?: any; error?: string }> =>
      ipcRenderer.invoke("auth:getUser"),

    onDeviceCode: (callback: (code: string) => void): (() => void) => {
      const subscription = (_event: IpcRendererEvent, code: string) =>
        callback(code);
      ipcRenderer.on("auth:deviceCode", subscription);

      return (): void => {
        ipcRenderer.removeListener("auth:deviceCode", subscription);
      };
    },
  },
};

contextBridge.exposeInMainWorld("electron", electronHandler);

export type ElectronHandler = typeof electronHandler;
