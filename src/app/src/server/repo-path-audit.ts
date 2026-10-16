import type { PrismaClient } from "@prisma/client";

import { getStateTreePaths } from "~/server/state-tree";
import { canonicalPathProblem, portablePathProblem } from "~/server/repo-path";

export interface PathAuditEntry {
  branch: string;
  path: string;
  problem: string;
  /** "canonical" problems hurt every client; "portable" ones some OSes. */
  rule: "canonical" | "portable";
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
      seenHeads.set(branch.headNumber, found);
    }
    for (const entry of found) entries.push({ ...entry, branch: branch.name });
  }
  return entries;
}
