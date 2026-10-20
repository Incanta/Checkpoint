import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { emailPasswordEnabled } from "./methods";

/**
 * How a user satisfies an org's "require MFA" setting, or null if they don't.
 *
 * TOTP only guards password sign-in, so the rule is about the password: a
 * user who can sign in with a password needs TOTP on top of it. Everyone
 * else signs in through something Checkpoint does not see the strength of
 * (an identity provider, which owns MFA for those users) or something that
 * is already a strong credential (a passkey), or cannot sign in to the web
 * app at all (an account that only holds API tokens, like a CI service
 * account).
 *
 * - "totp": has a password and a verified TOTP authenticator
 * - "passkey": no password, signs in with a passkey
 * - "identity-provider": no password, signs in through an IdP
 * - "api-only": no password, passkey, or IdP account
 */
export type MfaMethod = "totp" | "passkey" | "identity-provider" | "api-only";

export interface UserMfaStatus {
  userId: string;
  compliant: boolean;
  method: MfaMethod | null;
  hasPassword: boolean;
  twoFactorEnabled: boolean;
  passkeyCount: number;
  /** providerIds of the user's identity-provider accounts. */
  identityProviders: string[];
}

/** MFA status for each of `userIds`; ids with no user row are left out. */
export async function getMfaStatuses(
  db: PrismaClient,
  userIds: string[],
): Promise<Map<string, UserMfaStatus>> {
  const statuses = new Map<string, UserMfaStatus>();
  if (userIds.length === 0) return statuses;

  const [users, accounts, passkeys] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, twoFactorEnabled: true },
    }),
    db.account.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, providerId: true, password: true },
    }),
    db.passkey.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds } },
      _count: { _all: true },
    }),
  ]);

  // With email-password sign-in turned off, a stored password is not a way
  // in, so it does not need a second factor.
  const passwordsCount = emailPasswordEnabled();

  for (const user of users) {
    const userAccounts = accounts.filter((a) => a.userId === user.id);
    const hasPassword =
      passwordsCount &&
      userAccounts.some((a) => a.providerId === "credential" && !!a.password);
    const identityProviders = userAccounts
      .filter((a) => a.providerId !== "credential")
      .map((a) => a.providerId);
    const passkeyCount =
      passkeys.find((p) => p.userId === user.id)?._count._all ?? 0;
    const twoFactorEnabled = !!user.twoFactorEnabled;

    let method: MfaMethod | null;
    if (hasPassword) {
      method = twoFactorEnabled ? "totp" : null;
    } else if (passkeyCount > 0) {
      method = "passkey";
    } else if (identityProviders.length > 0) {
      method = "identity-provider";
    } else {
      method = "api-only";
    }

    statuses.set(user.id, {
      userId: user.id,
      compliant: method !== null,
      method,
      hasPassword,
      twoFactorEnabled,
      passkeyCount,
      identityProviders,
    });
  }

  return statuses;
}

export async function isMfaCompliant(
  db: PrismaClient,
  userId: string,
): Promise<boolean> {
  const status = (await getMfaStatuses(db, [userId])).get(userId);
  return status?.compliant ?? false;
}

export const MFA_REQUIRED_MESSAGE_PREFIX = "MFA required:";

export function mfaRequiredError(orgName: string): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message: `${MFA_REQUIRED_MESSAGE_PREFIX} the organization "${orgName}" requires two-factor authentication. Turn on an authenticator app in your account's security settings, or switch to a passkey and remove your password, to regain access.`,
  });
}

/**
 * Throws mfaRequiredError when the org requires MFA and the user does not
 * meet it. Call after the caller's membership has been established; it only
 * adds the MFA condition on top.
 */
export async function assertOrgMfa(
  db: PrismaClient,
  orgId: string,
  userId: string,
): Promise<void> {
  const org = await db.org.findUnique({
    where: { id: orgId },
    select: { name: true, requireMfa: true },
  });
  if (!org?.requireMfa) return;

  if (!(await isMfaCompliant(db, userId))) {
    throw mfaRequiredError(org.name);
  }
}
