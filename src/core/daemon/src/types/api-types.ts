import type { AppRouter } from "@checkpointvcs/app";

export type User = AppRouter["user"]["me"]["_def"]["$types"]["output"];

export type Org =
  AppRouter["org"]["myOrgs"]["_def"]["$types"]["output"][number];

export type Workspace =
  AppRouter["workspace"]["list"]["_def"]["$types"]["output"][number] & {
    localPath: string;
    daemonId: string;
  };
