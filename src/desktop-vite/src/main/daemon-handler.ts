import { MockedData } from "../common/mock-data";
import { accountsAtom, authAttemptAtom } from "../common/state/auth";
import { store } from "../common/state/store";

export default class DaemonHandler {
  // Your implementation here
  private isMocked: boolean;

  constructor() {
    this.isMocked = process.env.USE_MOCK_DATA === "true";
  }

  public async init(): Promise<void> {
    if (this.isMocked) {
      store.set(accountsAtom, []);
    }

    store.sub(authAttemptAtom, () => {
      this.handleAuthAttemptChange();
    });
  }

  private async handleAuthAttemptChange(): Promise<void> {
    const authAttempt = store.get(authAttemptAtom);
    if (authAttempt && authAttempt.serverEndpoint && !authAttempt.authCode) {
      if (this.isMocked) {
        store.set(authAttemptAtom, {
          serverEndpoint: authAttempt.serverEndpoint,
          authCode: "1234",
          finished: false,
        });
        setTimeout(() => {
          store.set(accountsAtom, MockedData.accounts);
          store.set(authAttemptAtom, {
            serverEndpoint: authAttempt.serverEndpoint,
            authCode: "1234",
            finished: true,
          });
        }, 2000);
      } else {
        // TODO: real implementation to interact with the daemon
      }
    }
  }
}
