import { User } from "./state/auth";
import { type Workspace } from "@checkpointvcs/daemon/types";

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace MockedData {
  export const availableUsers: number[] = [0];

  export const users: User[] = [
    {
      daemonId: "daemon-1",
      endpoint: "https://checkpointvcs.com",
      details: {
        id: "1",
        email: "user@gmail.com",
        username: "user1",
        name: "User One",
        image: null,
      },
    },
  ];

  export const workspaces: Workspace[] = [
    {
      id: "1",
      userId: "1",
      name: "Personal",
      orgId: "org1",
      repoId: "repo1",
      createdAt: new Date(),
      deletedAt: null,

      localPath: "E:/epic/engine/UE_Redwood",
      daemonId: "daemon-1",
      branchName: "main",
    },
  ];
}
