import { CreateApiClientAuth } from "@checkpointvcs/common";

import type { Workspace } from "../util.js";
import { Logger } from "../../logging.js";

/**
 * Report the changelist a workspace synced to (presence). Fire-and-forget:
 * failures are logged but never block sync completion.
 */
export async function reportSyncedChangelist(
  workspace: Workspace,
  changelistNumber: number | null,
): Promise<void> {
  try {
    const client = await CreateApiClientAuth(workspace.daemonId);
    await client.workspace.updateSyncStatus.mutate({
      workspaceId: workspace.id,
      changelistNumber,
    });
  } catch (err) {
    Logger.warn(
      `Failed to report sync status for workspace ${workspace.workspaceName}: ${err}`,
    );
  }
}
