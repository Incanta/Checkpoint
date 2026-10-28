import { promises as fs } from "fs";
import path from "path";
import { ownedWithin } from "../file-status.js";

// Folders inside a workspace that belong to another workspace: a Team Sync
// nested linked repo's mount path, or any folder with its own .checkpoint.
// Removals that sweep a whole directory must step around them.

/**
 * Removes the directory `relDir` (workspace-relative) and everything in it,
 * except the folders in `owned` and the path down to them. Returns whether
 * the directory itself was removed (false when it holds an owned folder).
 */
export async function removeTreeKeepingOwned(
  root: string,
  relDir: string,
  owned: readonly string[],
): Promise<boolean> {
  const inside = ownedWithin(owned, relDir);
  const abs = path.join(root, relDir);
  if (inside.length === 0) {
    await fs.rm(abs, { recursive: true, force: true });
    return true;
  }
  const lowered = relDir.toLowerCase();
  if (inside.some((o) => o.toLowerCase() === lowered)) return false;

  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await removeTreeKeepingOwned(root, childRel, inside);
    } else {
      await fs.rm(path.join(root, childRel), { force: true });
    }
  }
  return false;
}
