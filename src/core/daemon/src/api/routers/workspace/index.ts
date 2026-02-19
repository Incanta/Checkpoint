import { router } from "../../trpc";
import { branchesRouter } from "./branches";
import { conflictsRouter } from "./conflicts";
import { historyRouter } from "./history";
import { labelsRouter } from "./labels";
import { opsRouter } from "./ops";
import { pendingRouter } from "./pending";
import { syncRouter } from "./sync";

export const workspacesRouter = router({
  branches: branchesRouter,
  conflicts: conflictsRouter,
  history: historyRouter,
  labels: labelsRouter,
  ops: opsRouter,
  pending: pendingRouter,
  sync: syncRouter,
});
