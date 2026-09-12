import type { PrismaClient } from "@prisma/client";

/**
 * Extract @username mentions from text.
 * Returns unique usernames (lowercase) without the @ prefix.
 */
export function parseMentions(text: string): string[] {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentions = new Set<string>();
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    mentions.add(match[1]!.toLowerCase());
  }
  return Array.from(mentions);
}

/**
 * Resolve @usernames to user IDs.
 * Looks up by username first, then falls back to name (case-insensitive).
 */
export async function resolveUsernames(
  db: PrismaClient,
  usernames: string[],
): Promise<string[]> {
  if (usernames.length === 0) return [];

  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { in: usernames } },
        { name: { in: usernames } },
      ],
    },
    select: { id: true },
  });

  return users.map((u) => u.id);
}

/**
 * Ensure a user is subscribed to an issue. No-op if already subscribed.
 */
export async function subscribeToIssue(
  db: PrismaClient,
  issueId: string,
  userId: string,
): Promise<void> {
  await db.issueSubscription.upsert({
    where: { issueId_userId: { issueId, userId } },
    create: { issueId, userId },
    update: {},
  });
}

/**
 * Ensure a user is subscribed to a merge request. No-op if already subscribed.
 */
export async function subscribeToMR(
  db: PrismaClient,
  mergeRequestId: string,
  userId: string,
): Promise<void> {
  await db.mergeRequestSubscription.upsert({
    where: { mergeRequestId_userId: { mergeRequestId, userId } },
    create: { mergeRequestId, userId },
    update: {},
  });
}

interface NotifyOptions {
  db: PrismaClient;
  actorId: string;
  type: string;
  title: string;
  body?: string;
  link: string;
}

/**
 * Send in-app notifications to all subscribers of an issue,
 * excluding the actor. Also auto-subscribes mentioned users
 * and creates notifications for them.
 */
export async function notifyIssueSubscribers(
  opts: NotifyOptions & {
    issueId: string;
    text?: string; // body text to parse for @mentions
  },
): Promise<void> {
  const { db, actorId, type, title, body, link, issueId, text } = opts;

  // Auto-subscribe mentioned users
  if (text) {
    const usernames = parseMentions(text);
    const mentionedIds = await resolveUsernames(db, usernames);
    for (const uid of mentionedIds) {
      await subscribeToIssue(db, issueId, uid);
    }
  }

  // Get all subscribers except the actor
  const subs = await db.issueSubscription.findMany({
    where: { issueId, userId: { not: actorId } },
    select: { userId: true },
  });

  if (subs.length === 0) return;

  await db.notification.createMany({
    data: subs.map((s) => ({
      userId: s.userId,
      actorId,
      type,
      title,
      body: body ?? "",
      link,
      issueId,
    })),
  });
}

/**
 * Send in-app notifications to all subscribers of a merge request,
 * excluding the actor.
 */
export async function notifyMRSubscribers(
  opts: NotifyOptions & {
    mergeRequestId: string;
    text?: string;
  },
): Promise<void> {
  const { db, actorId, type, title, body, link, mergeRequestId, text } = opts;

  // Auto-subscribe mentioned users
  if (text) {
    const usernames = parseMentions(text);
    const mentionedIds = await resolveUsernames(db, usernames);
    for (const uid of mentionedIds) {
      await subscribeToMR(db, mergeRequestId, uid);
    }
  }

  // Get all subscribers except the actor
  const subs = await db.mergeRequestSubscription.findMany({
    where: { mergeRequestId, userId: { not: actorId } },
    select: { userId: true },
  });

  if (subs.length === 0) return;

  await db.notification.createMany({
    data: subs.map((s) => ({
      userId: s.userId,
      actorId,
      type,
      title,
      body: body ?? "",
      link,
      mergeRequestId,
    })),
  });
}
