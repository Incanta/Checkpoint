import type { WebContents } from "electron";

export type Channels = {
  "state:get": null;
  "atom:value": { key: string; value: any };
  "auth:login": { endpoint: string };
};

export function ipcSend<T extends keyof Channels>(
  sender: WebContents,
  channel: T,
  data: Channels[T],
): void {
  sender.send(channel, data);
}
