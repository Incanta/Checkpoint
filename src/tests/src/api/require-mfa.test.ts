/**
 * An org's "require MFA" setting (Org.requireMfa) and the rule behind it in
 * server/auth/mfa.ts: a user who can sign in with a password needs TOTP on
 * top of it; users without a password (passkey only, identity provider only,
 * API tokens only) already meet it. Members who don't keep their membership
 * but are treated as outsiders: only public repos stay readable, and every
 * org-scoped procedure refuses them with an "MFA required" error.
 *
 * The check runs on the user, not the session, so a better-auth session and
 * an `Authorization: Bearer <ApiToken>` session are refused alike (the caller
 * harness feeds ctx.session directly, which is what both resolve to).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../harness/db";
import {
  makeOrg,
  makeRepo,
  makeUser,
  type TestUser,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { setConfig } from "../harness/config";
import { getMfaStatuses } from "~/server/auth/mfa";
import { usersWithRepoRead } from "~/server/api/auth-utils";

/** The code a rejected tRPC call carries, or "OK" if it did not reject. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function mfaMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("require MFA", () => {
  let testDb: TestDb;
  let db: TestDb["client"];

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.client;
    globalThis.__checkpointTestDb = db;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
  });

  // ── Sign-in method fixtures ─────────────────────────────────────

  /** Password "secret" (see the $context stub in vitest-setup). */
  async function givePassword(user: TestUser) {
    await db.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: "hashed:secret",
      },
    });
  }

  async function giveTotp(user: TestUser) {
    await db.twoFactor.create({
      data: { userId: user.id, secret: "s", backupCodes: "b" },
    });
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true },
    });
  }

  async function givePasskey(user: TestUser) {
    await db.passkey.create({
      data: {
        userId: user.id,
        publicKey: "pk",
        credentialID: `cred-${user.id}`,
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
      },
    });
  }

  async function giveIdp(user: TestUser, providerId = "okta") {
    await db.account.create({
      data: { userId: user.id, accountId: `${providerId}-${user.id}`, providerId },
    });
  }

  async function passwordOnlyUser() {
    const user = await makeUser(db);
    await givePassword(user);
    return user;
  }

  async function totpUser() {
    const user = await makeUser(db);
    await givePassword(user);
    await giveTotp(user);
    return user;
  }

  async function requireMfa(orgId: string) {
    await db.org.update({ where: { id: orgId }, data: { requireMfa: true } });
  }

  // ── The rule ────────────────────────────────────────────────────

  describe("getMfaStatuses", () => {
    async function statusOf(user: TestUser) {
      return (await getMfaStatuses(db, [user.id])).get(user.id)!;
    }

    it("password without TOTP does not meet it", async () => {
      const user = await passwordOnlyUser();
      expect(await statusOf(user)).toMatchObject({
        compliant: false,
        method: null,
        hasPassword: true,
      });
    });

    it("password with TOTP meets it", async () => {
      const user = await totpUser();
      expect(await statusOf(user)).toMatchObject({
        compliant: true,
        method: "totp",
      });
    });

    it("a passkey does not cover a password that is still there", async () => {
      const user = await passwordOnlyUser();
      await givePasskey(user);
      expect(await statusOf(user)).toMatchObject({
        compliant: false,
        passkeyCount: 1,
      });
    });

    it("passkey only meets it", async () => {
      const user = await makeUser(db);
      await givePasskey(user);
      expect(await statusOf(user)).toMatchObject({
        compliant: true,
        method: "passkey",
      });
    });

    it("identity provider only meets it (the IdP owns MFA)", async () => {
      const user = await makeUser(db);
      await giveIdp(user, "microsoft-entra-id");
      expect(await statusOf(user)).toMatchObject({
        compliant: true,
        method: "identity-provider",
        identityProviders: ["microsoft-entra-id"],
      });
    });

    it("an identity provider does not cover a password beside it", async () => {
      const user = await passwordOnlyUser();
      await giveIdp(user);
      expect((await statusOf(user)).compliant).toBe(false);
    });

    it("an account with no sign-in method (API tokens only) meets it", async () => {
      const user = await makeUser(db);
      expect(await statusOf(user)).toMatchObject({
        compliant: true,
        method: "api-only",
      });
    });

    it("a credential account without a password hash is not a password", async () => {
      const user = await makeUser(db);
      await db.account.create({
        data: { userId: user.id, accountId: user.id, providerId: "credential" },
      });
      expect((await statusOf(user)).hasPassword).toBe(false);
    });

    it("a stored password does not count when email-password sign-in is off", async () => {
      setConfig("auth.email-password.enabled", false);
      const user = await passwordOnlyUser();
      expect(await statusOf(user)).toMatchObject({
        compliant: true,
        hasPassword: false,
      });
    });

    it("leaves out ids with no user", async () => {
      const statuses = await getMfaStatuses(db, ["missing"]);
      expect(statuses.size).toBe(0);
    });
  });

  // ── Enforcement ─────────────────────────────────────────────────

  describe("enforcement", () => {
    let owner: TestUser;
    let blocked: TestUser;
    let orgId: string;
    let orgName: string;
    let privateRepoId: string;
    let publicRepoId: string;

    beforeEach(async () => {
      owner = await totpUser();
      blocked = await passwordOnlyUser();
      const org = await makeOrg(db, {
        ownerId: owner.id,
        defaultRepoAccess: "WRITE",
      });
      orgId = org.id;
      orgName = org.name;
      await db.orgUser.create({
        data: { orgId, userId: blocked.id, role: "MEMBER" },
      });
      privateRepoId = (await makeRepo(db, orgId, owner.id)).id;
      publicRepoId = (await makeRepo(db, orgId, owner.id, { public: true }))
        .id;
    });

    it("control: with the setting off, a password-only member keeps access", async () => {
      const caller = await makeAppCaller({ asUser: blocked });
      expect(await codeOf(caller.repo.getRepo({ id: privateRepoId }))).toBe(
        "OK",
      );
    });

    it("refuses private repo reads with an MFA message naming the org", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      const message = await mfaMessageOf(
        caller.repo.getRepo({ id: privateRepoId }),
      );
      expect(message).toMatch(/^MFA required:/);
      expect(message).toContain(orgName);
    });

    it("refuses writes and repo admin", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      expect(
        await codeOf(caller.repo.updateRepo({ id: privateRepoId, name: "x" })),
      ).toBe("FORBIDDEN");
    });

    it("still lets the member read public repos", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      expect(await codeOf(caller.repo.getRepo({ id: publicRepoId }))).toBe(
        "OK",
      );
    });

    it("does not touch members who meet it", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: owner });
      expect(await codeOf(caller.repo.getRepo({ id: privateRepoId }))).toBe(
        "OK",
      );
    });

    it("blocks a non-member holding only a repo grant", async () => {
      const collaborator = await passwordOnlyUser();
      await db.repoRole.create({
        data: { repoId: privateRepoId, userId: collaborator.id, access: "WRITE" },
      });
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: collaborator });
      expect(
        await mfaMessageOf(caller.repo.getRepo({ id: privateRepoId })),
      ).toMatch(/^MFA required:/);
    });

    it("a stranger still gets the plain refusal, not the MFA one", async () => {
      await requireMfa(orgId);
      const stranger = await passwordOnlyUser();
      const caller = await makeAppCaller({ asUser: stranger });
      expect(
        await mfaMessageOf(caller.repo.getRepo({ id: privateRepoId })),
      ).toBe("You do not have access to this repository");
    });

    it("access comes back as soon as TOTP is on", async () => {
      await requireMfa(orgId);
      await giveTotp(blocked);
      const caller = await makeAppCaller({ asUser: blocked });
      expect(await codeOf(caller.repo.getRepo({ id: privateRepoId }))).toBe(
        "OK",
      );
    });

    it("turning TOTP off later takes access away again", async () => {
      await giveTotp(blocked);
      await requireMfa(orgId);
      await db.user.update({
        where: { id: blocked.id },
        data: { twoFactorEnabled: false },
      });
      const caller = await makeAppCaller({ asUser: blocked });
      expect(await codeOf(caller.repo.getRepo({ id: privateRepoId }))).toBe(
        "FORBIDDEN",
      );
    });

    it("getMyRepoAccess reports the block instead of the membership", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      expect(
        await caller.repo.getMyRepoAccess({ repoId: privateRepoId }),
      ).toEqual({
        isMember: false,
        canWrite: false,
        isAdmin: false,
        mfaBlocked: true,
      });
    });

    it("myOrgs keeps the org listed, flagged, with its repos hidden", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      const [org] = await caller.org.myOrgs();
      expect(org).toMatchObject({ id: orgId, mfaBlocked: true, repos: [] });
    });

    it("getOrg returns the outsider view, flagged", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      const org = await caller.org.getOrg({ id: orgId, includeUsers: true });
      expect(org).toMatchObject({ mfaBlocked: true, users: [] });
      expect(org!.repos.map((r) => r.id)).toEqual([publicRepoId]);
    });

    it("getAdmins stays open so the member knows whom to ask", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      const admins = await caller.org.getAdmins({ orgId });
      expect(admins.map((a) => a.id)).toEqual([owner.id]);
    });

    it("refuses repo.list, repo.createRepo, and org-scoped reads", async () => {
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      expect(await codeOf(caller.repo.list({ orgId }))).toBe("FORBIDDEN");
      expect(
        await codeOf(caller.repo.createRepo({ orgId, name: "new" })),
      ).toBe("FORBIDDEN");
      expect(await codeOf(caller.org.getOrgActivity({ orgId }))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(caller.org.getBinaryExtensions({ orgId }))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(caller.billing.getStorageUsage({ orgId }))).toBe(
        "FORBIDDEN",
      );
    });

    it("an org admin without MFA loses admin rights too", async () => {
      const admin = await passwordOnlyUser();
      await db.orgUser.create({
        data: { orgId, userId: admin.id, role: "ADMIN" },
      });
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: admin });
      expect(await codeOf(caller.org.updateOrg({ id: orgId, name: "y" }))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(caller.org.deleteOrg({ id: orgId }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(caller.org.setRequireMfa({ orgId, enabled: false })),
      ).toBe("FORBIDDEN");
    });

    it("an admin without MFA can't offer the org as an invite target", async () => {
      const admin = await passwordOnlyUser();
      await db.orgUser.create({
        data: { orgId, userId: admin.id, role: "ADMIN" },
      });
      const caller = await makeAppCaller({ asUser: admin });
      expect(
        (await caller.invite.grantableTargets()).orgs.map((o) => o.id),
      ).toContain(orgId);

      await requireMfa(orgId);
      const after = await caller.invite.grantableTargets();
      expect(after.orgs).toEqual([]);
      expect(after.repos).toEqual([]);
    });

    it("usersWithRepoRead leaves out members without MFA", async () => {
      await requireMfa(orgId);
      const allowed = await usersWithRepoRead(db, privateRepoId, [
        owner.id,
        blocked.id,
      ]);
      expect([...allowed]).toEqual([owner.id]);
    });

    it("usersWithRepoRead still includes everyone for a public repo", async () => {
      await requireMfa(orgId);
      const allowed = await usersWithRepoRead(db, publicRepoId, [
        owner.id,
        blocked.id,
      ]);
      expect(allowed).toEqual(new Set([owner.id, blocked.id]));
    });

    it("only the org that requires it is affected", async () => {
      const other = await makeOrg(db, { ownerId: blocked.id });
      const otherRepo = await makeRepo(db, other.id, blocked.id);
      await requireMfa(orgId);
      const caller = await makeAppCaller({ asUser: blocked });
      expect(await codeOf(caller.repo.getRepo({ id: otherRepo.id }))).toBe(
        "OK",
      );
    });
  });

  // ── Turning it on and off ───────────────────────────────────────

  describe("setRequireMfa and getMfaReport", () => {
    it("is admin only", async () => {
      const owner = await totpUser();
      const member = await totpUser();
      const org = await makeOrg(db, { ownerId: owner.id });
      await db.orgUser.create({
        data: { orgId: org.id, userId: member.id, role: "MEMBER" },
      });
      const caller = await makeAppCaller({ asUser: member });
      expect(
        await codeOf(caller.org.setRequireMfa({ orgId: org.id, enabled: true })),
      ).toBe("FORBIDDEN");
      expect(await codeOf(caller.org.getMfaReport({ orgId: org.id }))).toBe(
        "FORBIDDEN",
      );
    });

    it("refuses to turn it on for an admin who doesn't meet it", async () => {
      const owner = await passwordOnlyUser();
      const org = await makeOrg(db, { ownerId: owner.id });
      const caller = await makeAppCaller({ asUser: owner });
      expect(
        await codeOf(caller.org.setRequireMfa({ orgId: org.id, enabled: true })),
      ).toBe("PRECONDITION_FAILED");
      const row = await db.org.findUniqueOrThrow({ where: { id: org.id } });
      expect(row.requireMfa).toBe(false);
    });

    it("previews and then lists everyone who loses access", async () => {
      const owner = await totpUser();
      const noMfa = await passwordOnlyUser();
      const idpUser = await makeUser(db);
      await giveIdp(idpUser);
      const collaborator = await passwordOnlyUser();
      const org = await makeOrg(db, { ownerId: owner.id });
      await db.orgUser.createMany({
        data: [
          { orgId: org.id, userId: noMfa.id, role: "MEMBER" },
          { orgId: org.id, userId: idpUser.id, role: "MEMBER" },
        ],
      });
      const repo = await makeRepo(db, org.id, owner.id);
      await db.repoRole.create({
        data: { repoId: repo.id, userId: collaborator.id, access: "READ" },
      });
      const caller = await makeAppCaller({ asUser: owner });

      const preview = await caller.org.getMfaReport({ orgId: org.id });
      expect(preview.requireMfa).toBe(false);
      expect(preview.viewerCompliant).toBe(true);
      expect(preview.entries).toHaveLength(4);
      expect(preview.nonCompliant.map((e) => e.userId).sort()).toEqual(
        [noMfa.id, collaborator.id].sort(),
      );
      expect(
        preview.nonCompliant.find((e) => e.userId === collaborator.id)?.role,
      ).toBeNull();
      expect(
        preview.entries.find((e) => e.userId === idpUser.id)?.method,
      ).toBe("identity-provider");

      const after = await caller.org.setRequireMfa({
        orgId: org.id,
        enabled: true,
      });
      expect(after.requireMfa).toBe(true);
      expect(after.requireMfaEnabledBy).toBe(owner.id);
      expect(after.requireMfaEnabledAt).toBeInstanceOf(Date);
      expect(after.nonCompliant).toHaveLength(2);

      // Still listed after enabling.
      const later = await caller.org.getMfaReport({ orgId: org.id });
      expect(later.nonCompliant).toHaveLength(2);
    });

    it("turning it off restores access and clears who enabled it", async () => {
      const owner = await totpUser();
      const noMfa = await passwordOnlyUser();
      const org = await makeOrg(db, { ownerId: owner.id });
      await db.orgUser.create({
        data: { orgId: org.id, userId: noMfa.id, role: "MEMBER" },
      });
      const repo = await makeRepo(db, org.id, owner.id);
      const ownerCaller = await makeAppCaller({ asUser: owner });
      const memberCaller = await makeAppCaller({ asUser: noMfa });

      await ownerCaller.org.setRequireMfa({ orgId: org.id, enabled: true });
      expect(await codeOf(memberCaller.repo.getRepo({ id: repo.id }))).toBe(
        "FORBIDDEN",
      );

      const off = await ownerCaller.org.setRequireMfa({
        orgId: org.id,
        enabled: false,
      });
      expect(off).toMatchObject({
        requireMfa: false,
        requireMfaEnabledAt: null,
        requireMfaEnabledBy: null,
      });
      expect(await codeOf(memberCaller.repo.getRepo({ id: repo.id }))).toBe(
        "OK",
      );
    });

    it("updateOrg can't be used to flip it", async () => {
      const owner = await passwordOnlyUser();
      const org = await makeOrg(db, { ownerId: owner.id });
      const caller = await makeAppCaller({ asUser: owner });
      // Unknown keys are stripped by the input schema.
      await caller.org.updateOrg({
        id: org.id,
        ...({ requireMfa: true } as object),
      });
      const row = await db.org.findUniqueOrThrow({ where: { id: org.id } });
      expect(row.requireMfa).toBe(false);
    });
  });

  // ── Account security ────────────────────────────────────────────

  describe("user.security and user.removePassword", () => {
    it("lists the orgs the user is locked out of", async () => {
      const owner = await totpUser();
      const user = await passwordOnlyUser();
      const org = await makeOrg(db, { ownerId: owner.id });
      await db.orgUser.create({
        data: { orgId: org.id, userId: user.id, role: "MEMBER" },
      });
      await requireMfa(org.id);
      const caller = await makeAppCaller({ asUser: user });

      const security = await caller.user.security();
      expect(security.blockedOrgs.map((o) => o.id)).toEqual([org.id]);
      expect(security.canRemovePassword).toBe(false);

      await giveTotp(user);
      expect((await caller.user.security()).blockedOrgs).toEqual([]);
    });

    it("won't remove the only way to sign in", async () => {
      const user = await passwordOnlyUser();
      const caller = await makeAppCaller({ asUser: user });
      expect(
        await codeOf(caller.user.removePassword({ password: "secret" })),
      ).toBe("PRECONDITION_FAILED");
    });

    it("needs the current password", async () => {
      const user = await passwordOnlyUser();
      await givePasskey(user);
      const caller = await makeAppCaller({ asUser: user });
      expect(
        await codeOf(caller.user.removePassword({ password: "wrong" })),
      ).toBe("UNAUTHORIZED");
      expect(
        await db.account.count({
          where: { userId: user.id, providerId: "credential" },
        }),
      ).toBe(1);
    });

    it("refuses when there is no password", async () => {
      const user = await makeUser(db);
      await givePasskey(user);
      const caller = await makeAppCaller({ asUser: user });
      expect(
        await codeOf(caller.user.removePassword({ password: "secret" })),
      ).toBe("PRECONDITION_FAILED");
    });

    it("removes the password and TOTP, which meets the requirement", async () => {
      const owner = await totpUser();
      const user = await totpUser();
      await givePasskey(user);
      const org = await makeOrg(db, { ownerId: owner.id });
      await db.orgUser.create({
        data: { orgId: org.id, userId: user.id, role: "MEMBER" },
      });
      const repo = await makeRepo(db, org.id, owner.id);
      await requireMfa(org.id);
      const caller = await makeAppCaller({ asUser: user });

      await caller.user.removePassword({ password: "secret" });

      expect(
        await db.account.count({
          where: { userId: user.id, providerId: "credential" },
        }),
      ).toBe(0);
      expect(await db.twoFactor.count({ where: { userId: user.id } })).toBe(0);
      const security = await caller.user.security();
      expect(security).toMatchObject({
        hasPassword: false,
        twoFactorEnabled: false,
        method: "passkey",
        compliant: true,
      });
      expect(await codeOf(caller.repo.getRepo({ id: repo.id }))).toBe("OK");
    });

    it("an identity provider account is enough to drop the password", async () => {
      const user = await passwordOnlyUser();
      await giveIdp(user, "keycloak");
      const caller = await makeAppCaller({ asUser: user });
      await caller.user.removePassword({ password: "secret" });
      expect((await caller.user.security()).method).toBe("identity-provider");
    });
  });
});
