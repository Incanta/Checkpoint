import type { IpcMain } from "electron";
import { MockedData } from "../common/mock-data";
import { Account, accountsAtom, authAccountAtom } from "../common/state/auth";
import { store } from "../common/state/store";
import { Channels, ipcOn } from "./channels";

export default class DaemonHandler {
  // Your implementation here
  private isMocked: boolean;
  private ipcMain: IpcMain;

  constructor(ipcMain: IpcMain) {
    this.isMocked = process.env.USE_MOCK_DATA === "true";
    this.ipcMain = ipcMain;
  }

  public async init(): Promise<void> {
    if (this.isMocked) {
      store.set(accountsAtom, []);
    }

    ipcOn(this.ipcMain, "auth:login", async (_event, data) => {
      this.handleLogin(data);
    });
  }

  private async handleLogin(data: Channels["auth:login"]): Promise<void> {
    if (this.isMocked) {
      for (const availableAccount of MockedData.availableAccounts) {
        if (MockedData.accounts[availableAccount].endpoint === data.endpoint) {
          const account = MockedData.accounts[availableAccount];
          MockedData.availableAccounts.splice(
            MockedData.availableAccounts.indexOf(availableAccount),
            1,
          );

          const nextAuthAccount: Account = {
            ...account,
            daemonId: data.daemonId,
            details: null,
            auth: { code: "1234" },
          };

          store.set(authAccountAtom, nextAuthAccount);

          setTimeout(() => {
            const currentAuthAccount = store.get(authAccountAtom);

            if (!currentAuthAccount) return;

            const nextAccount: Account = {
              ...currentAuthAccount,
              details: account.details,
              auth: undefined,
            };

            store.set(authAccountAtom, nextAccount);

            const currentAccounts = store.get(accountsAtom) || [];
            const nextAccounts = currentAccounts
              .filter((a) => a.daemonId !== data.daemonId)
              .concat(nextAccount);

            store.set(accountsAtom, nextAccounts);
          }, 2000);

          break;
        }
      }
    } else {
      // TODO: real implementation to interact with the daemon
    }
  }
}
