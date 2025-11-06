import { Account } from "./state/auth";
import { FileStatus, FileType, Workspace } from "./state/workspace";

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

  export const workspaces: Workspace[] = [
    {
      id: "1",
      accountId: "1",
      name: "Personal",
      repoId: "repo1",
      rootPath: "E:/epic/engine/UE_Redwood",

      pendingChanges: {
        numChanges: 3,
        files: [
          {
            path: "E:/epic/engine/UE_Redwood/.gitignore",
            type: FileType.Text,
            size: 150,
            modifiedAt: Date.now() - 100000,

            status: FileStatus.ChangedCheckedOut,
            id: "file-1",
            changelist: 2,
          },
          {
            path: "E:/epic/engine/UE_Redwood/.gitignore2",
            type: FileType.Text,
            size: 150,
            modifiedAt: Date.now() - 100000,

            status: FileStatus.ChangedCheckedOut,
            id: "file-2",
            changelist: 2,
          },
        ],
      },
    },
  ];
}
