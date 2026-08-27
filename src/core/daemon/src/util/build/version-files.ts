import { existsSync, promises as fs } from "fs";
import path from "path";

import type { Workspace } from "../util.js";
import { Logger } from "../../logging.js";

/**
 * Rewrite Engine/Build/Build.version with the synced changelist so local
 * builds report the correct BUILT_FROM_CHANGELIST (UGS parity). Opt-in and
 * only meaningful for an in-workspace engine. No-op when the file is absent
 * (installed-engine workspaces carry their own version).
 *
 * Skipped by callers when precompiled binaries were applied (those binaries
 * bake their own version).
 */
export async function writeVersionFiles(
  workspace: Workspace,
  changelistNumber: number,
  branchName: string,
): Promise<boolean> {
  const versionPath = path.join(
    workspace.localPath,
    "Engine",
    "Build",
    "Build.version",
  );

  if (!existsSync(versionPath)) {
    return false;
  }

  try {
    const raw = await fs.readFile(versionPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    parsed["Changelist"] = changelistNumber;
    parsed["CompatibleChangelist"] = changelistNumber;
    parsed["IsLicenseeVersion"] = parsed["IsLicenseeVersion"] ?? 0;
    parsed["IsPromotedBuild"] = 0;
    parsed["BranchName"] = branchName.replace(/\//g, "+");

    await fs.writeFile(versionPath, JSON.stringify(parsed, null, 2) + "\n");
    return true;
  } catch (err) {
    Logger.warn(
      `Failed to write Build.version for workspace ${workspace.workspaceName}: ${err}`,
    );
    return false;
  }
}
