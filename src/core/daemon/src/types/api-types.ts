import type { AppRouter } from "@checkpointvcs/app";

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace ApiTypes {
  export type User = AppRouter["user"]["me"]["_def"]["$types"]["output"];

  export type Org =
    AppRouter["org"]["myOrgs"]["_def"]["$types"]["output"][number];

  export type Repo =
    AppRouter["repo"]["list"]["_def"]["$types"]["output"][number];

  export type Workspace =
    AppRouter["workspace"]["list"]["_def"]["$types"]["output"][number];
}
