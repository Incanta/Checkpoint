import type { BuildBadgeState, PrismaClient } from "@prisma/client";
import type { InputJsonValue } from "@prisma/client/runtime/library";

import { walkChangelistAncestry } from "~/server/changelist-walk";
import { notifyBadgeTransition } from "./notifications";
import { dispatchBadgeWebhooks } from "./webhooks";

export interface BadgeInput {
  name: string;
  group?: string;
  state: BuildBadgeState;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertBadgeResult {
  id: string;
  previousState: BuildBadgeState | null;
}

/**
 * Upsert a single build badge (latest-state-only) and fire notification +
 * webhook side effects on meaningful transitions. Shared by the tRPC router
 * and the REST ingest endpoint.
 */
export async function upsertBadge(
  db: PrismaClient,
  repoId: string,
  orgName: string,
  repoName: string,
  changelistNumber: number,
  posterId: string,
  input: BadgeInput,
): Promise<UpsertBadgeResult> {
  const existing = await db.buildBadge.findUnique({
    where: {
      repoId_changelistNumber_name: {
        repoId,
        changelistNumber,
        name: input.name,
      },
    },
    select: { state: true },
  });
  const previousState = existing?.state ?? null;

  const badge = await db.buildBadge.upsert({
    where: {
      repoId_changelistNumber_name: {
        repoId,
        changelistNumber,
        name: input.name,
      },
    },
    create: {
      repoId,
      changelistNumber,
      name: input.name,
      group: input.group ?? null,
      state: input.state,
      url: input.url ?? null,
      metadata: (input.metadata as InputJsonValue) ?? undefined,
      postedById: posterId,
    },
    update: {
      group: input.group ?? null,
      state: input.state,
      url: input.url ?? null,
      metadata: (input.metadata as InputJsonValue) ?? undefined,
      postedById: posterId,
    },
    select: { id: true },
  });

  const brokeNow = previousState !== "FAILURE" && input.state === "FAILURE";
  const recoveredNow =
    previousState === "FAILURE" && input.state === "SUCCESS";

  if (brokeNow || recoveredNow) {
    // Side effects are best-effort and must never fail the badge write.
    void notifyBadgeTransition(db, {
      repoId,
      orgName,
      repoName,
      changelistNumber,
      badgeName: input.name,
      transition: brokeNow ? "failure" : "recovered",
      actorId: posterId,
    }).catch(() => undefined);

    void dispatchBadgeWebhooks(db, {
      repoId,
      changelistNumber,
      badgeName: input.name,
      state: input.state,
      url: input.url ?? null,
      transition: brokeNow ? "failure" : "recovered",
    }).catch(() => undefined);
  }

  return { id: badge.id, previousState };
}

/**
 * Find the newest ancestor changelist at or before `startNumber` where every
 * required badge is SUCCESS (UGS "sync to latest good"). Walks the parent
 * chain in pages so long histories stay bounded by `maxScan`.
 */
export async function findLatestGoodChangelist(
  db: PrismaClient,
  repoId: string,
  startNumber: number,
  requiredBadges: string[],
  maxScan: number,
): Promise<number | null> {
  if (requiredBadges.length === 0) return null;

  const pageSize = 250;
  let cursor: number | null = startNumber;
  let scanned = 0;

  while (cursor !== null && scanned < maxScan) {
    const limit = Math.min(pageSize, maxScan - scanned);
    const { numbers, nextNumber } = await walkChangelistAncestry(
      db,
      repoId,
      cursor,
      limit,
    );
    if (numbers.length === 0) break;
    scanned += numbers.length;

    const badges = await db.buildBadge.findMany({
      where: {
        repoId,
        changelistNumber: { in: numbers },
        name: { in: requiredBadges },
        state: "SUCCESS",
      },
      select: { changelistNumber: true, name: true },
    });

    const successByNumber = new Map<number, Set<string>>();
    for (const badge of badges) {
      const set = successByNumber.get(badge.changelistNumber) ?? new Set();
      set.add(badge.name);
      successByNumber.set(badge.changelistNumber, set);
    }

    for (const number of numbers) {
      const successes = successByNumber.get(number);
      if (successes && requiredBadges.every((name) => successes.has(name))) {
        return number;
      }
    }

    cursor = nextNumber;
  }

  return null;
}
