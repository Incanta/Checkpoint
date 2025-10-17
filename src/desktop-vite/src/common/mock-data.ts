import { Account } from "./state/auth";

export namespace MockedData {
  export const accounts: Account[] = [
    {
      id: "1",
      serverEndpoint: "https://checkpointvcs.com",
      email: "user@gmail.com",
      username: "user1",
      name: "User One",
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
