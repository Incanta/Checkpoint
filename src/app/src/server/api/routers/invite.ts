import { z } from "zod";
import { TRPCError } from "@trpc/server";
import config from "@incanta/config";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { getCheckpointUser } from "~/server/api/auth-utils";
import { getInviteMode, normalizeEmail } from "~/server/invites";
import { isLicenseManager } from "~/server/license-utils";
import { sendEmail, isEmailEnabled, inviteToSignupEmail } from "~/server/email";
import { Logger } from "~/server/logging";
import type { PrismaClient } from "@prisma/client";

const orgRoleInput = z.object({
  orgId: z.string(),
  role: z.enum(["MEMBER", "BILLING", "ADMIN"]).default("MEMBER"),
});

const repoRoleInput = z.object({
  repoId: z.string(),
  access: z.enum(["READ", "WRITE", "ADMIN"]).default("WRITE"),
});

/** Build the signup URL an invitee follows to register. */
function buildSignupUrl(token: string): string {
  const base = config.get<string>("server.external-url").replace(/\/$/, "");
  return `${base}/signin?invite=${encodeURIComponent(token)}`;
}

/**
 * Set of org ids the user may grant membership in, and repo ids the user may
 * grant access to. checkpointAdmins may grant anything.
 */
async function getGrantableScope(
  db: PrismaClient,
  userId: string,
  isCheckpointAdmin: boolean,
): Promise<{ orgIds: Set<string>; repoIds: Set<string> }> {
  if (isCheckpointAdmin) {
    const [orgs, repos] = await Promise.all([
      db.org.findMany({ where: { deletedAt: null }, select: { id: true } }),
      db.repo.findMany({ where: { deletedAt: null }, select: { id: true } }),
    ]);
    return {
      orgIds: new Set(orgs.map((o) => o.id)),
      repoIds: new Set(repos.map((r) => r.id)),
    };
  }

  const orgIds = new Set<string>();
  const repoIds = new Set<string>();

  // Orgs the user administers: they can grant membership and full repo access.
  const adminMemberships = await db.orgUser.findMany({
    where: { userId, role: "ADMIN" },
    include: {
      org: {
        include: { repos: { where: { deletedAt: null }, select: { id: true } } },
      },
    },
  });
  for (const m of adminMemberships) {
    if (m.org.deletedAt) continue;
    orgIds.add(m.orgId);
    for (const repo of m.org.repos) {
      repoIds.add(repo.id);
    }
  }

  // Repos the user has explicit ADMIN access to.
  const adminRepoRoles = await db.repoRole.findMany({
    where: { userId, access: "ADMIN" },
    include: { repo: { select: { id: true, deletedAt: true } } },
  });
  for (const rr of adminRepoRoles) {
    if (!rr.repo.deletedAt) {
      repoIds.add(rr.repoId);
    }
  }

  return { orgIds, repoIds };
}

export const inviteRouter = createTRPCRouter({
  /** Whether the current user may create invitations. */
  canInvite: protectedProcedure.query(async ({ ctx }) => {
    const mode = getInviteMode();
    const user = await getCheckpointUser(ctx);
    const canInvite = mode === "admin" ? user.checkpointAdmin : true;
    // The BILLING org role only makes sense on license-manager instances; the
    // UI uses this to hide it as a grantable option elsewhere.
    return { canInvite, mode, isLicenseManager: isLicenseManager() };
  }),

  /**
   * Look up an invite by token for prefilling the signup form. Public so the
   * signin page can call it before the user is authenticated.
   */
  getByToken: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      const invite = await ctx.db.invite.findUnique({
        where: { token: input.token },
      });

      if (invite?.status !== "PENDING") {
        return { valid: false as const };
      }
      if (invite.expiresAt && invite.expiresAt < new Date()) {
        return { valid: false as const };
      }

      return {
        valid: true as const,
        email: invite.email,
        displayName: invite.displayName,
      };
    }),

  /** Invitations visible to the current user (own, or all for admins). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const user = await getCheckpointUser(ctx);
    const invites = await ctx.db.invite.findMany({
      where: user.checkpointAdmin ? {} : { invitedById: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        invitedBy: { select: { id: true, name: true, email: true } },
        orgRoles: { include: { org: { select: { id: true, name: true } } } },
        repoRoles: {
          include: {
            repo: {
              select: { id: true, name: true, org: { select: { name: true } } },
            },
          },
        },
      },
    });

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      displayName: invite.displayName,
      username: invite.username,
      status: invite.status,
      token: invite.token,
      signupUrl: buildSignupUrl(invite.token),
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      acceptedAt: invite.acceptedAt,
      invitedBy: invite.invitedBy,
      orgRoles: invite.orgRoles.map((r) => ({
        orgId: r.orgId,
        orgName: r.org.name,
        role: r.role,
      })),
      repoRoles: invite.repoRoles.map((r) => ({
        repoId: r.repoId,
        repoName: r.repo.name,
        orgName: r.repo.org.name,
        access: r.access,
      })),
    }));
  }),

  /** Orgs and repos the current user may grant access to when inviting. */
  grantableTargets: protectedProcedure.query(async ({ ctx }) => {
    const user = await getCheckpointUser(ctx);
    const { orgIds, repoIds } = await getGrantableScope(
      ctx.db,
      user.id,
      user.checkpointAdmin,
    );

    const [orgs, repos] = await Promise.all([
      ctx.db.org.findMany({
        where: { id: { in: [...orgIds] }, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      ctx.db.repo.findMany({
        where: { id: { in: [...repoIds] }, deletedAt: null },
        select: { id: true, name: true, org: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
    ]);

    return {
      orgs,
      repos: repos.map((r) => ({
        id: r.id,
        name: r.name,
        orgName: r.org.name,
      })),
    };
  }),

  create: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        displayName: z.string().trim().min(1).optional(),
        username: z.string().trim().min(1).optional(),
        orgRoles: z.array(orgRoleInput).default([]),
        repoRoles: z.array(repoRoleInput).default([]),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const mode = getInviteMode();
      const user = await getCheckpointUser(ctx);
      const canInvite = mode === "admin" ? user.checkpointAdmin : true;
      if (!canInvite) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to invite users",
        });
      }

      const email = normalizeEmail(input.email);

      // Refuse if that email already has an account.
      const existingUser = await ctx.db.user.findUnique({ where: { email } });
      if (existingUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A user with that email already exists",
        });
      }

      // Refuse a duplicate outstanding invite.
      const existingInvite = await ctx.db.invite.findFirst({
        where: { email, status: "PENDING" },
      });
      if (existingInvite) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "There is already a pending invite for that email",
        });
      }

      // The BILLING org role is only meaningful on license-manager instances.
      if (!isLicenseManager()) {
        for (const orgRole of input.orgRoles) {
          if (orgRole.role === "BILLING") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "The Billing role is not available on this instance",
            });
          }
        }
      }

      // Validate the requested grants against what this user may bestow.
      const { orgIds, repoIds } = await getGrantableScope(
        ctx.db,
        user.id,
        user.checkpointAdmin,
      );
      for (const orgRole of input.orgRoles) {
        if (!orgIds.has(orgRole.orgId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You cannot grant access to one of the selected organizations",
          });
        }
      }
      for (const repoRole of input.repoRoles) {
        if (!repoIds.has(repoRole.repoId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You cannot grant access to one of the selected repositories",
          });
        }
      }

      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const invite = await ctx.db.invite.create({
        data: {
          email,
          displayName: input.displayName,
          username: input.username,
          invitedById: user.id,
          expiresAt,
          orgRoles: {
            create: input.orgRoles.map((r) => ({
              orgId: r.orgId,
              role: r.role,
            })),
          },
          repoRoles: {
            create: input.repoRoles.map((r) => ({
              repoId: r.repoId,
              access: r.access,
            })),
          },
        },
        include: {
          orgRoles: { include: { org: { select: { name: true } } } },
          repoRoles: { include: { repo: { select: { name: true } } } },
        },
      });

      const signupUrl = buildSignupUrl(invite.token);
      const emailSent = await maybeSendInviteEmail(
        email,
        user.name ?? user.email ?? "A Checkpoint user",
        signupUrl,
        invite.orgRoles.map((r) => r.org.name),
        invite.repoRoles.map((r) => r.repo.name),
      );

      return { id: invite.id, token: invite.token, signupUrl, emailSent };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await getCheckpointUser(ctx);
      const invite = await ctx.db.invite.findUnique({
        where: { id: input.id },
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }
      if (!user.checkpointAdmin && invite.invitedById !== user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot revoke this invite",
        });
      }
      if (invite.status !== "PENDING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only pending invites can be revoked",
        });
      }

      await ctx.db.invite.update({
        where: { id: input.id },
        data: { status: "REVOKED" },
      });
      return { success: true };
    }),

  resend: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await getCheckpointUser(ctx);
      const invite = await ctx.db.invite.findUnique({
        where: { id: input.id },
        include: {
          orgRoles: { include: { org: { select: { name: true } } } },
          repoRoles: { include: { repo: { select: { name: true } } } },
        },
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }
      if (!user.checkpointAdmin && invite.invitedById !== user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot resend this invite",
        });
      }
      if (invite.status !== "PENDING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only pending invites can be resent",
        });
      }

      const signupUrl = buildSignupUrl(invite.token);
      const emailSent = await maybeSendInviteEmail(
        invite.email,
        user.name ?? user.email ?? "A Checkpoint user",
        signupUrl,
        invite.orgRoles.map((r) => r.org.name),
        invite.repoRoles.map((r) => r.repo.name),
      );
      return { emailSent, signupUrl };
    }),
});

/** Send the invite email when email is configured; never throws. */
async function maybeSendInviteEmail(
  to: string,
  inviterName: string,
  signupUrl: string,
  orgNames: string[],
  repoNames: string[],
): Promise<boolean> {
  if (!isEmailEnabled()) {
    return false;
  }
  const summaryParts = [...orgNames, ...repoNames];
  const summary =
    summaryParts.length > 0 ? summaryParts.join(", ") : undefined;
  try {
    return await sendEmail({
      to,
      ...inviteToSignupEmail(inviterName, signupUrl, summary),
    });
  } catch (err: any) {
    Logger.warn(
      `[invites] Failed to send invite email to ${to}: ${JSON.stringify(err)}`,
    );
    return false;
  }
}
