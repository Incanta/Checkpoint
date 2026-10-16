import type { PrismaClient } from "@prisma/client";

import { getStateTreePaths } from "~/server/state-tree";
import {
  canonicalPathProblem,
  foldName,
  portablePathProblem,
} from "~/server/repo-path";

export interface PathAuditEntry {
  branch: string;
  path: string;
  problem: string;
  /**
   * "canonical" problems hurt every client; "portable" ones some OSes; "fold"
   * marks two spellings of one name on Windows and macOS.
   */
  rule: "canonical" | "portable" | "fold";
}

/**
 * Every path at every live branch head that the path rules would refuse if
 * it were added today. Paths stored before the rules are grandfathered (they
 * can still be edited, renamed, and deleted); this lists them so a team can
 * rename them. Reads whole trees, so it is an admin tool, not a request path.
 */
export async function auditRepoPaths(
  db: PrismaClient,
  repoId: string,
): Promise<PathAuditEntry[]> {
  const branches = await db.branch.findMany({
    where: { repoId, archivedAt: null },
    orderBy: { name: "asc" },
  });
  const entries: PathAuditEntry[] = [];
  const seenHeads = new Map<number, PathAuditEntry[]>();
  for (const branch of branches) {
    let found = seenHeads.get(branch.headNumber);
    if (!found) {
      found = [];
      const tree = await getStateTreePaths(db, repoId, branch.headNumber);
      for (const path of tree.keys()) {
        const canonical = canonicalPathProblem(path);
        if (canonical) {
          found.push({
            branch: "",
            path,
            problem: canonical,
            rule: "canonical",
          });
          continue;
        }
        const portable = portablePathProblem(path);
        if (portable) {
          found.push({ branch: "", path, problem: portable, rule: "portable" });
        }
      }
      // Every directory or file name that another spelling at the same place
      // folds onto (see foldName). Each prefix is a name at its depth.
      const spellings = new Map<string, Set<string>>();
      for (const path of tree.keys()) {
        const parts = path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join("/");
          const key = parts.slice(0, i).map(foldName).join("/");
          let set = spellings.get(key);
          if (!set) spellings.set(key, (set = new Set()));
          set.add(prefix);
        }
      }
      for (const set of spellings.values()) {
        if (set.size < 2) continue;
        const names = [...set].sort();
        // Report a collision where it starts: below it, every path differs
        // already in its parent, and the parent is what is reported.
        const parents = new Set(
          names.map((n) => n.slice(0, Math.max(0, n.lastIndexOf("/")))),
        );
        if (parents.size > 1) continue;
        for (const path of names) {
          found.push({
            branch: "",
            path,
            problem: `the same name as ${names.filter((n) => n !== path).join(", ")} on Windows and macOS`,
            rule: "fold",
          });
        }
      }
      seenHeads.set(branch.headNumber, found);
    }
    for (const entry of found) entries.push({ ...entry, branch: branch.name });
  }
  return entries;
}
