import "server-only";

import type { PrismaClient } from "@prisma/client";
import config from "@incanta/config";
import { Logger } from "./logging";

export type InviteMode = "public" | "member" | "admin";

/**
 * Registration policy for the instance.
 *   "public" - anyone may register; the invite page is still available so
 *              members can pre-provision access.
 *   "member" - only the first user may self-register; everyone else needs an
 *              invite, and any member may create invites.
 *   "admin"  - like "member", but only a checkpointAdmin may create invites.
 */
export function getInviteMode(): InviteMode {
  const mode = config.get<string>("auth.invite-only");
  if (mode === "public" || mode === "member" || mode === "admin") {
    return mode;
  }
  // Fail closed to the most restrictive setting if misconfigured.
  Logger.warn(
    `[invites] Unknown auth.invite-only value "${mode}"; defaulting to "admin"`,
  );
  return "admin";
}

/** Emails are stored/compared lowercased so matching is provider-agnostic. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Find a PENDING, unexpired invite for the given email (most recent first).
 * Returns null when none applies.
 */
export async function findValidInviteByEmail(
  db: PrismaClient,
  email: string,
) {
  return db.invite.findFirst({
    where: {
      email: normalizeEmail(email),
      status: "PENDING",
      OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
    include: { orgRoles: true, repoRoles: true },
  });
}

/**
 * Materialize an invite's pending access grants onto a freshly-created user
 * and mark the invite ACCEPTED. Safe to call once per invite; grants that
 * already exist (e.g. a repeated hook) are skipped.
 */
export async function consumeInvite(
  db: PrismaClient,
  inviteId: string,
  userId: string,
): Promise<void> {
  const invite = await db.invite.findUnique({
    where: { id: inviteId },
    include: { orgRoles: true, repoRoles: true },
  });

  if (!invite || invite.status !== "PENDING") {
    return;
  }

  // Apply the username from the invite if the user didn't set one at signup.
  if (invite.username) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    if (user && !user.username) {
      await db.user.update({
        where: { id: userId },
        data: { username: invite.username },
      });
    }
  }

  // Org memberships. Skip any the user is already a member of.
  for (const orgRole of invite.orgRoles) {
    const existing = await db.orgUser.findFirst({
      where: { orgId: orgRole.orgId, userId },
    });
    if (!existing) {
      await db.orgUser.create({
        data: { orgId: orgRole.orgId, userId, role: orgRole.role },
      });
    }
  }

  // Repo-specific roles. Skip any that already exist.
  for (const repoRole of invite.repoRoles) {
    const existing = await db.repoRole.findFirst({
      where: { repoId: repoRole.repoId, userId },
    });
    if (!existing) {
      await db.repoRole.create({
        data: {
          repoId: repoRole.repoId,
          userId,
          access: repoRole.access,
        },
      });
    }
  }

  await db.invite.update({
    where: { id: inviteId },
    data: {
      status: "ACCEPTED",
      acceptedById: userId,
      acceptedAt: new Date(),
    },
  });
}
