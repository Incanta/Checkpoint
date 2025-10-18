import { Account } from "./state/auth";

export namespace MockedData {
  export const availableAccounts: number[] = [0];

  export const accounts: Account[] = [
    {
      daemonId: "daemon-1",
      endpoint: "https://checkpointvcs.com",
      details: {
        id: "1",
        email: "user@gmail.com",
        username: "user1",
        name: "User One",
      },
    },
  ];

  export const workspaces: any[] = [
    {
      id: "1",
      accountId: "1",
      name: "Personal",
      orgId: "org1",
      repoId: "repo1",
      path: "/path/to/personal",
      pending: [],
    },
  ];
}
