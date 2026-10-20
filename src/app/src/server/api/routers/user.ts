import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getCheckpointUser } from "../auth-utils";
import { isLicenseManager } from "~/server/license-utils";
import { auth } from "~/server/auth/config";
import { getMfaStatuses } from "~/server/auth/mfa";
import { emailPasswordEnabled, passkeysEnabled } from "~/server/auth/methods";

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
    const checkpointUser = await getCheckpointUser(ctx);

    return { ...checkpointUser, isLicenseManager: isLicenseManager() };
  }),

  updateUser: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        username: z.string().optional(),
        email: z.string().email().optional(),
        image: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updateData } = input;

      // Only your own profile. The id is still accepted so existing clients
      // keep working, but it has to be yours: with any id, anyone could
      // change another user's email and take the account over.
      if (id !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only update your own profile",
        });
      }

      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: updateData,
      });
    }),

  /**
   * What the security settings page needs: the caller's sign-in methods, how
   * they meet an org's MFA requirement, and which orgs they are locked out of.
   */
  security: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const status = (await getMfaStatuses(ctx.db, [userId])).get(userId);
    if (!status) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }

    const requiringOrgs = await ctx.db.org.findMany({
      where: { deletedAt: null, requireMfa: true, users: { some: { userId } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    return {
      ...status,
      emailPasswordEnabled: emailPasswordEnabled(),
      passkeysEnabled: passkeysEnabled(),
      // A password can only go once there is another way to sign in.
      canRemovePassword:
        status.hasPassword &&
        (status.passkeyCount > 0 || status.identityProviders.length > 0),
      orgsRequiringMfa: requiringOrgs,
      blockedOrgs: status.compliant ? [] : requiringOrgs,
    };
  }),

  /**
   * Delete the caller's password so they sign in only with a passkey or an
   * identity provider. TOTP only guards the password, so it goes too.
   */
  removePassword: protectedProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const status = (await getMfaStatuses(ctx.db, [userId])).get(userId);
      const credential = await ctx.db.account.findFirst({
        where: { userId, providerId: "credential", password: { not: null } },
      });

      if (!status || !credential?.password) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Your account has no password to remove",
        });
      }
      if (status.passkeyCount === 0 && status.identityProviders.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Add a passkey before removing your password, or you will have no way to sign in",
        });
      }

      const authContext = await (await auth).$context;
      const valid = await authContext.password.verify({
        password: input.password,
        hash: credential.password,
      });
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Incorrect password",
        });
      }

      await ctx.db.$transaction([
        ctx.db.account.delete({ where: { id: credential.id } }),
        ctx.db.twoFactor.deleteMany({ where: { userId } }),
        ctx.db.user.update({
          where: { id: userId },
          data: { twoFactorEnabled: false },
        }),
      ]);

      return { success: true };
    }),
});
