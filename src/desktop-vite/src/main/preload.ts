// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import { Titlebar, TitlebarColor } from "@incanta/custom-electron-titlebar";
import { Channels } from "./channels";

const electronHandler = {
  ipcRenderer: {
    sendMessage<T extends keyof Channels>(channel: T, data: Channels[T]): void {
      ipcRenderer.send(channel, data);
    },

    on<T extends keyof Channels>(
      channel: T,
      func: (data: Channels[T]) => void,
    ): () => void {
      const subscription = (_event: IpcRendererEvent, data: Channels[T]) =>
        func(data);
      ipcRenderer.on(channel, subscription);

      return (): void => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },

    once<T extends keyof Channels>(
      channel: T,
      func: (data: Channels[T]) => void,
    ): void {
      ipcRenderer.once(channel, (_event, data) => func(data));
    },
  },
};

contextBridge.exposeInMainWorld("electron", electronHandler);

export type ElectronHandler = typeof electronHandler;

window.addEventListener("DOMContentLoaded", () => {
  // Title bar implementation
  new Titlebar({
    backgroundColor: TitlebarColor.fromHex("#2c2c2c"),
    titleHorizontalAlignment: "center",
    minWidth: 1050,
    minHeight: 530,
  } as any);
});
