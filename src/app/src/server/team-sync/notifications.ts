import type { PrismaClient } from "@prisma/client";

import { walkChangelistAncestry } from "~/server/changelist-walk";

const BLAME_SCAN_LIMIT = 50;

interface BadgeTransitionOptions {
  repoId: string;
  orgName: string;
  repoName: string;
  changelistNumber: number;
  badgeName: string;
  transition: "failure" | "recovered";
  actorId: string;
}

function changelistLink(
  orgName: string,
  repoName: string,
  changelistNumber: number,
): string {
  return `/${orgName}/${repoName}/history?cl=${changelistNumber}`;
}

/**
 * Notify the people who most likely caused (or care about) a badge break or
 * recovery: the authors of the changelists from the breaking CL back to the
 * last CL where the same badge was green, plus anyone currently investigating.
 * Best-effort; callers do not await the result on the hot path.
 */
export async function notifyBadgeTransition(
  db: PrismaClient,
  opts: BadgeTransitionOptions,
): Promise<void> {
  const {
    repoId,
    orgName,
    repoName,
    changelistNumber,
    badgeName,
    transition,
    actorId,
  } = opts;

  const recipients = new Set<string>();

  // Blame range: walk ancestors until the previous SUCCESS of this badge.
  const { numbers } = await walkChangelistAncestry(
    db,
    repoId,
    changelistNumber,
    BLAME_SCAN_LIMIT,
  );

  const greenBefore = await db.buildBadge.findMany({
    where: {
      repoId,
      name: badgeName,
      state: "SUCCESS",
      changelistNumber: { in: numbers, lt: changelistNumber },
    },
    select: { changelistNumber: true },
    orderBy: { changelistNumber: "desc" },
    take: 1,
  });
  const stopAfter = greenBefore[0]?.changelistNumber ?? -Infinity;
  const blameNumbers = numbers.filter((n) => n > stopAfter);

  const authors = await db.changelist.findMany({
    where: { repoId, number: { in: blameNumbers }, userId: { not: null } },
    select: { userId: true },
  });
  for (const author of authors) {
    if (author.userId) recipients.add(author.userId);
  }

  // Anyone investigating this changelist.
  const investigators = await db.changelistReview.findMany({
    where: { repoId, changelistNumber, investigating: true },
    select: { userId: true },
  });
  for (const investigator of investigators) {
    recipients.add(investigator.userId);
  }

  recipients.delete(actorId);
  if (recipients.size === 0) return;

  const type =
    transition === "failure" ? "build_badge_failure" : "build_badge_recovered";
  const title =
    transition === "failure"
      ? `${badgeName} broken at CL ${changelistNumber}`
      : `${badgeName} fixed at CL ${changelistNumber}`;
  const link = changelistLink(orgName, repoName, changelistNumber);

  const recipientIds = [...recipients];

  // Dedup: skip a recipient who already has an unread notification with the
  // same type + link (prevents CI-retry spam).
  const existing = await db.notification.findMany({
    where: { type, link, read: false, userId: { in: recipientIds } },
    select: { userId: true },
  });
  const alreadyNotified = new Set(existing.map((n) => n.userId));
  const toCreate = recipientIds.filter((id) => !alreadyNotified.has(id));
  if (toCreate.length === 0) return;

  await db.notification.createMany({
    data: toCreate.map((userId) => ({
      userId,
      actorId,
      type,
      title,
      link,
    })),
  });
}

/**
 * Notify a changelist's author (plus prior commenters/investigators) that a
 * new comment was left, excluding the actor.
 */
export async function notifyChangelistComment(
  db: PrismaClient,
  opts: {
    repoId: string;
    orgName: string;
    repoName: string;
    changelistNumber: number;
    actorId: string;
  },
): Promise<void> {
  const { repoId, orgName, repoName, changelistNumber, actorId } = opts;
  const recipients = new Set<string>();

  const changelist = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { userId: true },
  });
  if (changelist?.userId) recipients.add(changelist.userId);

  const commenters = await db.changelistComment.findMany({
    where: { repoId, changelistNumber },
    select: { authorId: true },
    distinct: ["authorId"],
  });
  for (const commenter of commenters) recipients.add(commenter.authorId);

  recipients.delete(actorId);
  if (recipients.size === 0) return;

  await db.notification.createMany({
    data: [...recipients].map((userId) => ({
      userId,
      actorId,
      type: "changelist_comment",
      title: `New comment on CL ${changelistNumber}`,
      link: changelistLink(orgName, repoName, changelistNumber),
    })),
  });
}

/**
 * Notify a changelist's author that their change was marked bad.
 */
export async function notifyChangelistMarkedBad(
  db: PrismaClient,
  opts: {
    repoId: string;
    orgName: string;
    repoName: string;
    changelistNumber: number;
    actorId: string;
  },
): Promise<void> {
  const { repoId, orgName, repoName, changelistNumber, actorId } = opts;
  const changelist = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { userId: true },
  });
  if (!changelist?.userId || changelist.userId === actorId) return;

  await db.notification.create({
    data: {
      userId: changelist.userId,
      actorId,
      type: "changelist_marked_bad",
      title: `CL ${changelistNumber} was marked bad`,
      link: changelistLink(orgName, repoName, changelistNumber),
    },
  });
}
