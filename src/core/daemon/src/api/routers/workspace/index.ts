import { router } from "../../trpc.js";
import { artifactsRouter } from "./artifacts.js";
import { branchesRouter } from "./branches.js";
import { conflictsRouter } from "./conflicts.js";
import { historyRouter } from "./history.js";
import { labelsRouter } from "./labels.js";
import { opsRouter } from "./ops.js";
import { pendingRouter } from "./pending.js";
import { shelvesRouter } from "./shelves.js";
import { syncRouter } from "./sync.js";

export const workspacesRouter = router({
  artifacts: artifactsRouter,
  branches: branchesRouter,
  conflicts: conflictsRouter,
  history: historyRouter,
  labels: labelsRouter,
  ops: opsRouter,
  pending: pendingRouter,
  shelves: shelvesRouter,
  sync: syncRouter,
});
