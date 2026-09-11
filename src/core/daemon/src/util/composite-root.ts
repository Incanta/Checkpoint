import path from "path";
import os from "os";
import { promises as fs, existsSync } from "fs";

import { readStagedBlob, hasStagedBlob } from "./staged-blobs.js";

/**
 * Materializes a tree for submit in which partially-staged files carry their
 * staged content and every other file is the worktree file.
 *
 * WHY THIS EXISTS: `SubmitAsyncOptions` takes a single `localRootPath` and no
 * per-file override, so the only way to submit content that differs from the
 * working tree is to point the addon at a different root. The alternative, a
 * per-file override, would mean changing the native addon's interface and
 * republishing it.
 *
 * WHY IT IS CHEAP: only the files being submitted are materialized, not the
 * repo. A changelist is small; a game worktree is not. Unmodified files are
 * hardlinked rather than copied, so even a large changelist costs directory
 * entries rather than bytes.
 *
 * ASSUMPTION TO VERIFY AGAINST THE REAL ADDON: that submit reads only the
 * paths named in `modifications`, relative to `localRootPath`, and does not
 * walk the whole tree to build its version index. If it does walk the tree,
 * this approach needs revisiting, and the per-file override (and an addon
 * change) becomes the honest answer. `prepareCompositeRoot` returns null when
 * nothing is partially staged, so the common path never touches any of this.
 */

export interface CompositeRoot {
  /** Pass this as `localRootPath` instead of the workspace path. */
  rootPath: string;
  /** Always call this, successful or not. */
  cleanup: () => Promise<void>;
}

/**
 * Builds the composite root, or returns null when no submitted file has
 * partially-staged content and the worktree can be submitted directly.
 */
export async function prepareCompositeRoot(
  workspaceLocalPath: string,
  relPaths: string[],
): Promise<CompositeRoot | null> {
  const partial = relPaths.filter((p) => hasStagedBlob(workspaceLocalPath, p));
  if (partial.length === 0) {
    return null;
  }

  const rootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "checkpoint-submit-"),
  );

  const cleanup = async (): Promise<void> => {
    try {
      await fs.rm(rootPath, { recursive: true, force: true });
    } catch {
      // A leaked temp dir is a tidiness problem, never a correctness one, and
      // must not mask a submit error.
    }
  };

  try {
    const partialSet = new Set(partial);

    for (const relPath of relPaths) {
      const destination = path.join(rootPath, relPath);
      await fs.mkdir(path.dirname(destination), { recursive: true });

      if (partialSet.has(relPath)) {
        const content = await readStagedBlob(workspaceLocalPath, relPath);
        if (content === null) {
          // The blob vanished between the check and now. Falling back to the
          // worktree would silently submit unstaged hunks, so refuse.
          throw new Error(
            `Staged content for "${relPath}" is missing; re-stage it and submit again.`,
          );
        }
        await fs.writeFile(destination, content, "utf-8");
        continue;
      }

      const source = path.join(workspaceLocalPath, relPath);
      if (!existsSync(source)) {
        // A deletion: there is nothing to materialize, and the modification
        // entry already carries the delete flag.
        continue;
      }

      try {
        await fs.link(source, destination);
      } catch {
        // Hardlinks fail across volumes and on some filesystems; a copy is
        // correct either way, just slower.
        await fs.copyFile(source, destination);
      }
    }

    return { rootPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
