import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  createTRPCRouter,
  licenseManagerAdminProcedure,
  protectedProcedure,
} from "~/server/api/trpc";
import { createOrgDirectory } from "~/server/storage-service";
import { RepoAccess, type OrgRole, type PrismaClient } from "@prisma/client";
import {
  assertOrgMfa,
  getMfaStatuses,
  isMfaCompliant,
  type MfaMethod,
} from "~/server/auth/mfa";
import {
  getDefaultBinaryExtensions,
  resolveBinaryExtensions,
} from "~/server/binary-extensions";
import { Logger } from "~/server/logging";
import { getBillingPeriod } from "~/server/billing/billing-period";

async function assertOrgAdmin(
  db: PrismaClient,
  orgId: string,
  userId: string,
): Promise<void> {
  const orgUser = await db.orgUser.findFirst({ where: { orgId, userId } });
  if (orgUser?.role !== "ADMIN") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to manage this organization",
    });
  }
}

export interface MfaReportEntry {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  /** Org role, or null for someone who only holds a per-repo grant. */
  role: OrgRole | null;
  compliant: boolean;
  method: MfaMethod | null;
  identityProviders: string[];
}

async function buildMfaReport(
  db: PrismaClient,
  orgId: string,
  viewerId: string,
) {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      requireMfa: true,
      requireMfaEnabledAt: true,
      requireMfaEnabledBy: true,
    },
  });

  const userSelect = { id: true, name: true, email: true, image: true };
  const [members, collaborators] = await Promise.all([
    db.orgUser.findMany({
      where: { orgId },
      include: { user: { select: userSelect } },
    }),
    // People granted a repo without being org members lose it too.
    db.repoRole.findMany({
      where: {
        repo: { orgId, deletedAt: null },
        access: { not: "NONE" },
        user: { orgs: { none: { orgId } } },
      },
      distinct: ["userId"],
      include: { user: { select: userSelect } },
    }),
  ]);

  const people = [
    ...members.map((m) => ({ user: m.user, role: m.role })),
    ...collaborators.map((c) => ({ user: c.user, role: null })),
  ];
  const statuses = await getMfaStatuses(
    db,
    people.map((p) => p.user.id),
  );

  const entries: MfaReportEntry[] = people.map(({ user, role }) => {
    const status = statuses.get(user.id);
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role,
      compliant: status?.compliant ?? false,
      method: status?.method ?? null,
      identityProviders: status?.identityProviders ?? [],
    };
  });
  entries.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));

  return {
    requireMfa: org.requireMfa,
    requireMfaEnabledAt: org.requireMfaEnabledAt,
    requireMfaEnabledBy: org.requireMfaEnabledBy,
    viewerCompliant: statuses.get(viewerId)?.compliant ?? false,
    entries,
    nonCompliant: entries.filter((e) => !e.compliant),
  };
}

export const orgRouter = createTRPCRouter({
  myOrgs: protectedProcedure.query(async ({ ctx }) => {
    const orgs = await ctx.db.org.findMany({
      where: {
        deletedAt: null,
        users: {
          some: {
            userId: ctx.session.user.id,
          },
        },
      },
      include: {
        repos: {
          where: {
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
          },
        },
        users: {
          where: { userId: ctx.session.user.id },
          select: { role: true },
        },
      },
    });

    // Members an org's MFA requirement locks out still see the org listed,
    // flagged, so the UI can tell them why it is empty; its repos are hidden.
    const compliant = orgs.some((o) => o.requireMfa)
      ? await isMfaCompliant(ctx.db, ctx.session.user.id)
      : true;
    return orgs.map((org) => {
      const mfaBlocked = org.requireMfa && !compliant;
      return {
        ...org,
        repos: mfaBlocked ? [] : org.repos,
        mfaBlocked,
      };
    });
  }),

  getOrg: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        idIsName: z.boolean().default(false),
        includeUsers: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const org = await ctx.db.org.findFirst({
        where: input.idIsName ? { name: input.id } : { id: input.id },
        include: {
          users: {
            include: {
              user: input.includeUsers,
            },
          },
          repos: {
            include: {
              additionalRoles: true,
            },
          },
        },
      });

      if (!org) {
        return null;
      }

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: org.id,
          userId: ctx.session.user.id,
        },
      });

      const mfaBlocked =
        !!orgUser &&
        org.requireMfa &&
        !(await isMfaCompliant(ctx.db, ctx.session.user.id));

      if (!orgUser || mfaBlocked) {
        // Return only public repos if user is not a member, and none of
        // their per-user grants: those name the org's members and what each
        // may do. A member locked out by the MFA requirement gets the same.
        return {
          id: org.id,
          name: org.name,
          defaultRepoAccess: RepoAccess.NONE,
          defaultCanCreateRepos: false,
          requireMfa: org.requireMfa,
          repos: (org.repos ?? [])
            .filter((repo) => repo.public && !repo.deletedAt)
            .map((repo) => ({ ...repo, additionalRoles: [] })),
          users: [],
          mfaBlocked,
        };
      }

      // Filter repos based on access permissions
      const filteredRepos =
        org.repos?.filter(
          (repo) =>
            repo.public ||
            org.defaultRepoAccess !== "NONE" ||
            repo.additionalRoles.some(
              (role) =>
                role.userId === orgUser.userId && role.access !== "NONE",
            ),
        ) || [];

      return {
        ...org,
        repos: filteredRepos,
        mfaBlocked: false,
      };
    }),

  getDeleteStats: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.id,
          userId: ctx.session.user.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to view this organization",
        });
      }
      await assertOrgMfa(ctx.db, input.id, ctx.session.user.id);

      const repos = await ctx.db.repo.findMany({
        where: { orgId: input.id, deletedAt: null },
        select: { id: true, name: true, storageBytes: true },
        orderBy: { name: "asc" },
      });

      const reposWithSize = repos.map((r) => ({
        id: r.id,
        name: r.name,
        storageBytes: Number(r.storageBytes),
      }));

      const totalStorageBytes = reposWithSize.reduce(
        (sum, r) => sum + r.storageBytes,
        0,
      );

      return {
        repoCount: reposWithSize.length,
        totalStorageBytes,
        repos: reposWithSize,
      };
    }),

  getAdmins: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
      });

      if (!orgUser) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this organization",
        });
      }
      // Deliberately not behind the org's MFA requirement: a locked-out
      // member needs to know which admins to ask.

      const admins = await ctx.db.orgUser.findMany({
        where: { orgId: input.orgId, role: "ADMIN" },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      });

      return admins.map((a) => ({
        id: a.user.id,
        name: a.user.name,
        email: a.user.email,
        image: a.user.image,
      }));
    }),

  createOrg: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.db.org.create({
        data: {
          name: input.name,
        },
      });

      // Add the creator as an admin
      await ctx.db.orgUser.create({
        data: {
          orgId: org.id,
          userId: ctx.session.user.id,
          role: "ADMIN",
        },
      });

      // Create the org directory in storage
      try {
        await createOrgDirectory(org.id);
      } catch (error: any) {
        Logger.error(
          `Failed to create org directory in storage: ${JSON.stringify(error)}`,
        );
      }

      return org;
    }),

  updateOrg: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        defaultRepoAccess: z
          .enum(["NONE", "READ", "WRITE", "ADMIN"])
          .optional(),
        defaultCanCreateRepos: z.boolean().optional(),
        binaryExtensions: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updateData } = input;

      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: id,
          userId: ctx.session.user.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to update this organization",
        });
      }
      await assertOrgMfa(ctx.db, id, ctx.session.user.id);

      return ctx.db.org.update({
        where: { id },
        data: updateData,
      });
    }),

  deleteOrg: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.id,
          userId: ctx.session.user.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to delete this organization",
        });
      }
      await assertOrgMfa(ctx.db, input.id, ctx.session.user.id);

      return ctx.db.org.update({
        where: { id: input.id },
        data: {
          deletedAt: new Date(),
          deletedBy: ctx.session.user.id,
        },
      });
    }),

  addUserToOrg: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        userEmail: z.string().email(),
        role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check if the current user is an admin of the org
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
      });

      if (orgUser?.role !== "ADMIN") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You do not have permission to add users to this organization",
        });
      }
      await assertOrgMfa(ctx.db, input.orgId, ctx.session.user.id);

      // Find the user to add by email
      const userToAdd = await ctx.db.user.findUnique({
        where: { email: input.userEmail },
      });

      if (!userToAdd) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User with the specified email not found",
        });
      }

      // Check if user is already in the org
      const existingOrgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: userToAdd.id,
        },
      });

      if (existingOrgUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "User is already a member of this organization",
        });
      }

      // Add the user to the org
      const newOrgUser = await ctx.db.orgUser.create({
        data: {
          orgId: input.orgId,
          userId: userToAdd.id,
          role: input.role,
        },
      });

      return newOrgUser;
    }),

  getOrgActivity: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
        year: z.number().optional(),
        month: z.number().min(1).max(12).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Verify user is a member of the org
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
      });

      if (!orgUser) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this organization",
        });
      }
      await assertOrgMfa(ctx.db, input.orgId, ctx.session.user.id);

      const org = await ctx.db.org.findUnique({
        where: { id: input.orgId },
        select: { billingCycleAnchor: true },
      });
      const defaultPeriod = getBillingPeriod(
        new Date(),
        org?.billingCycleAnchor ?? 1,
      );
      const year = input.year ?? defaultPeriod.year;
      const month = input.month ?? defaultPeriod.month;

      const activities = await ctx.db.orgUserActivity.findMany({
        where: {
          orgId: input.orgId,
          year,
          month,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
        orderBy: [{ writeCount: "desc" }, { readCount: "desc" }],
      });

      const summary = {
        year,
        month,
        totalActiveWriteUsers: activities.filter((a) => a.writeCount > 0)
          .length,
        totalActiveReadUsers: activities.filter(
          (a) => a.readCount > 0 && a.writeCount === 0,
        ).length,
        totalActiveUsers: activities.length,
      };

      return { activities, summary };
    }),

  // Sets an org's tier with no payment, so it is for Checkpoint staff only.
  // Org admins and billing managers change tiers through billing.changeTier,
  // which goes through Stripe.
  updateSubscription: licenseManagerAdminProcedure
    .input(
      z.object({
        orgId: z.string(),
        tier: z.enum(["BASIC", "PRO", "STUDIO", "INCANTA"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Update org tier
      const org = await ctx.db.org.update({
        where: { id: input.orgId },
        data: { subscriptionTier: input.tier },
      });

      // Also update the associated license if one exists
      const license = await ctx.db.license.findUnique({
        where: { orgId: input.orgId },
      });
      if (license) {
        await ctx.db.license.update({
          where: { id: license.id },
          data: { tier: input.tier },
        });
      }

      return org;
    }),

  /**
   * Every member and repo collaborator of the org with how (or whether) they
   * meet the "require MFA" rule. Admin only; the settings page lists the
   * people who would lose, or have lost, access.
   */
  getMfaReport: protectedProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertOrgAdmin(ctx.db, input.orgId, ctx.session.user.id);
      await assertOrgMfa(ctx.db, input.orgId, ctx.session.user.id);
      return buildMfaReport(ctx.db, input.orgId, ctx.session.user.id);
    }),

  setRequireMfa: protectedProcedure
    .input(z.object({ orgId: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      await assertOrgAdmin(ctx.db, input.orgId, userId);
      await assertOrgMfa(ctx.db, input.orgId, userId);

      // Turning it on without MFA would lock the caller out of the page they
      // are on, with nobody left who can turn it back off.
      if (input.enabled && !(await isMfaCompliant(ctx.db, userId))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Turn on two-factor authentication for your own account before requiring it for the organization.",
        });
      }

      await ctx.db.org.update({
        where: { id: input.orgId },
        data: input.enabled
          ? {
              requireMfa: true,
              requireMfaEnabledAt: new Date(),
              requireMfaEnabledBy: userId,
            }
          : {
              requireMfa: false,
              requireMfaEnabledAt: null,
              requireMfaEnabledBy: null,
            },
      });

      const report = await buildMfaReport(ctx.db, input.orgId, userId);
      Logger.info(
        `[Org] ${userId} ${input.enabled ? "enabled" : "disabled"} required MFA for org ${input.orgId}; ${report.nonCompliant.length} user(s) without MFA`,
      );
      return report;
    }),

  getBinaryExtensions: protectedProcedure
    .input(
      z.object({
        orgId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const orgUser = await ctx.db.orgUser.findFirst({
        where: {
          orgId: input.orgId,
          userId: ctx.session.user.id,
        },
      });

      if (!orgUser) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have access to this organization",
        });
      }
      await assertOrgMfa(ctx.db, input.orgId, ctx.session.user.id);

      const org = await ctx.db.org.findUnique({
        where: { id: input.orgId },
        select: { binaryExtensions: true },
      });

      if (!org) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Organization not found",
        });
      }

      const defaults = getDefaultBinaryExtensions();
      const resolved = [...resolveBinaryExtensions(org.binaryExtensions)];

      return {
        defaults,
        overrides: org.binaryExtensions,
        resolved,
      };
    }),
});
