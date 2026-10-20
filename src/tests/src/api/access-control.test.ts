/**
 * Access-control red team for the app's tRPC routers and the REST routes
 * beside them.
 *
 * Every procedure resolves the caller from `ctx.session` (a better-auth
 * session or an `Authorization: Bearer <ApiToken>`), then authorizes through
 * getUserAndRepoWithAccess (repo READ / WRITE / ADMIN), an OrgUser role check,
 * or assertWorkspaceOwnership. These tests try to get around those checks:
 * foreign ids (IDOR), other users' workspaces and claims, read-only roles that
 * write, removed members, deleted repos and orgs, tokens that should no longer
 * work, storage tokens used outside their repo, and input spread into Prisma.
 *
 * The "finding" tests failed before their fix; the "control" tests pin
 * protections that already held, so a later change cannot quietly drop them.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import njwt from "njwt";
import type { NextRequest } from "next/server";

import { createTestDb, type TestDb } from "../harness/db";
import {
  makeApiToken,
  makeBranch,
  makeFile,
  makeOrg,
  makeRepo,
  makeUser,
  makeWorkspace,
  type TestOrg,
  type TestRepo,
  type TestUser,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import { setConfig } from "../harness/config";
import { verifyRepoToken } from "../../../core/server/src/utils/repo-token.js";
import { storageSigningKey } from "~/server/storage-signing-key";
import * as licenseUtils from "~/server/license-utils";
import { getSession } from "~/server/auth";

// The license manager gate is read from a verified handshake at runtime;
// tests flip it per case.
vi.mock("~/server/license-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/license-utils")>();
  return { ...actual, isLicenseManager: vi.fn().mockReturnValue(false) };
});

// The download route reads the session from next/headers; feed it directly.
vi.mock("~/server/auth", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  auth: Promise.resolve({ api: { getSession: vi.fn() } }),
}));

type Caller = Awaited<ReturnType<typeof makeAppCaller>>;

/** The code a rejected tRPC call carries, or "OK" if it did not reject. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe("access control", () => {
  let testDb: TestDb;
  let db: TestDb["client"];

  // Org A: owner (ADMIN), writer (MEMBER + repo WRITE), reader (MEMBER with
  // READ by org default). Org B: a separate tenant with its own owner.
  let owner: TestUser;
  let writer: TestUser;
  let reader: TestUser;
  let outsider: TestUser;
  let orgA: TestOrg;
  let repoA: TestRepo;
  let orgB: TestOrg;
  let repoB: TestRepo;
  let ownerB: TestUser;

  let asOwner: Caller;
  let asWriter: Caller;
  let asReader: Caller;
  let asOutsider: Caller;
  let asOwnerB: Caller;

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
    vi.mocked(licenseUtils.isLicenseManager).mockReturnValue(false);

    owner = await makeUser(db);
    writer = await makeUser(db);
    reader = await makeUser(db);
    outsider = await makeUser(db);
    ownerB = await makeUser(db);

    orgA = await makeOrg(db, {
      ownerId: owner.id,
      ownerRole: "ADMIN",
      defaultRepoAccess: "READ",
    });
    await db.orgUser.createMany({
      data: [
        { orgId: orgA.id, userId: writer.id, role: "MEMBER" },
        { orgId: orgA.id, userId: reader.id, role: "MEMBER" },
      ],
    });
    repoA = await makeRepo(db, orgA.id, owner.id);
    await db.repoRole.create({
      data: { repoId: repoA.id, userId: writer.id, access: "WRITE" },
    });

    orgB = await makeOrg(db, { ownerId: ownerB.id, ownerRole: "ADMIN" });
    repoB = await makeRepo(db, orgB.id, ownerB.id);

    asOwner = await makeAppCaller({ asUser: owner });
    asWriter = await makeAppCaller({ asUser: writer });
    asReader = await makeAppCaller({ asUser: reader });
    asOutsider = await makeAppCaller({ asUser: outsider });
    asOwnerB = await makeAppCaller({ asUser: ownerB });
  });

  // ── Account ─────────────────────────────────────────────────────

  describe("user.updateUser", () => {
    it("finding: refuses to update another user's profile (account takeover by email change)", async () => {
      const code = await codeOf(
        asOutsider.user.updateUser({
          id: owner.id,
          email: "attacker@evil.test",
        }),
      );
      expect(code).toBe("FORBIDDEN");

      const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(row.email).toBe(owner.email);
    });

    it("control: updates your own profile", async () => {
      await asOutsider.user.updateUser({ id: outsider.id, name: "Renamed" });
      const row = await db.user.findUniqueOrThrow({ where: { id: outsider.id } });
      expect(row.name).toBe("Renamed");
    });

    it("control: cannot mass-assign checkpointAdmin", async () => {
      await asOutsider.user.updateUser({
        id: outsider.id,
        checkpointAdmin: true,
      } as unknown as { id: string });
      const row = await db.user.findUniqueOrThrow({ where: { id: outsider.id } });
      expect(row.checkpointAdmin).toBe(false);
    });
  });

  // ── Orgs ────────────────────────────────────────────────────────

  describe("org", () => {
    it("finding: an org admin cannot set its own tier without paying (updateSubscription)", async () => {
      vi.mocked(licenseUtils.isLicenseManager).mockReturnValue(true);

      const code = await codeOf(
        asOwner.org.updateSubscription({ orgId: orgA.id, tier: "INCANTA" }),
      );
      expect(code).toBe("FORBIDDEN");

      const row = await db.org.findUniqueOrThrow({ where: { id: orgA.id } });
      expect(row.subscriptionTier).toBe("BASIC");
    });

    it("control: a Checkpoint admin can still set a tier on the license manager", async () => {
      vi.mocked(licenseUtils.isLicenseManager).mockReturnValue(true);
      const staff = await makeUser(db, { checkpointAdmin: true });
      const asStaff = await makeAppCaller({ asUser: staff });

      await asStaff.org.updateSubscription({ orgId: orgA.id, tier: "PRO" });
      const row = await db.org.findUniqueOrThrow({ where: { id: orgA.id } });
      expect(row.subscriptionTier).toBe("PRO");
    });

    it("finding: getOrg does not show a non-member who holds per-repo grants on public repos", async () => {
      await db.repo.update({ where: { id: repoA.id }, data: { public: true } });

      const org = await asOutsider.org.getOrg({ id: orgA.id });
      expect(org!.repos).toHaveLength(1);
      expect(org!.repos[0]!.additionalRoles).toEqual([]);
    });

    it("control: org settings, delete, and membership need the org ADMIN role", async () => {
      expect(
        await codeOf(asWriter.org.updateOrg({ id: orgA.id, name: "x" })),
      ).toBe("FORBIDDEN");
      expect(await codeOf(asWriter.org.deleteOrg({ id: orgA.id }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(
          asWriter.org.addUserToOrg({
            orgId: orgA.id,
            userEmail: outsider.email,
            role: "ADMIN",
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(asOwnerB.org.getDeleteStats({ id: orgA.id })),
      ).toBe("FORBIDDEN");
    });

    it("control: updateOrg cannot mass-assign billing fields", async () => {
      await asOwner.org.updateOrg({
        id: orgA.id,
        subscriptionTier: "INCANTA",
        creditBalanceCents: 1_000_000,
      } as unknown as { id: string });
      const row = await db.org.findUniqueOrThrow({ where: { id: orgA.id } });
      expect(row.subscriptionTier).toBe("BASIC");
      expect(row.creditBalanceCents).toBe(0);
    });

    it("control: org-scoped reads refuse non-members", async () => {
      expect(await codeOf(asOwnerB.repo.list({ orgId: orgA.id }))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(asOwnerB.org.getAdmins({ orgId: orgA.id }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(asOwnerB.org.getOrgActivity({ orgId: orgA.id })),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(asOwnerB.org.getBinaryExtensions({ orgId: orgA.id })),
      ).toBe("FORBIDDEN");
    });
  });

  // ── Repos: roles, foreign ids, removal, deletion ────────────────

  describe("repo access", () => {
    it("control: another org's private repo is refused by id", async () => {
      expect(await codeOf(asOwner.repo.getRepo({ id: repoB.id }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(
          asOwner.changelist.getChangelist({
            repoId: repoB.id,
            changelistNumber: 0,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(asOwner.branch.listBranches({ repoId: repoB.id })),
      ).toBe("FORBIDDEN");
    });

    it("control: a read-only member cannot write", async () => {
      expect(
        await codeOf(
          asReader.branch.createBranch({
            repoId: repoA.id,
            name: "feat",
            parentBranchName: "main",
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(
          asReader.storage.getToken({
            repoId: repoA.id,
            write: true,
            clientProtocol: 3,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(
          asReader.issue.create({ repoId: repoA.id, title: "nope" }),
        ),
      ).toBe("FORBIDDEN");
    });

    it("control: a writer cannot administer the repo", async () => {
      expect(
        await codeOf(asWriter.repo.updateRepo({ id: repoA.id, public: true })),
      ).toBe("FORBIDDEN");
      expect(await codeOf(asWriter.repo.deleteRepo({ id: repoA.id }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(
          asWriter.repo.setMergePermissions({
            repoId: repoA.id,
            type: "MAINLINE",
            userEmails: [writer.email],
          }),
        ),
      ).toBe("FORBIDDEN");
    });

    it("control: a removed member loses write and org-default read", async () => {
      await db.repoRole.deleteMany({ where: { userId: writer.id } });
      await db.orgUser.deleteMany({ where: { userId: writer.id } });

      expect(await codeOf(asWriter.repo.getRepo({ id: repoA.id }))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(
          asWriter.storage.getToken({
            repoId: repoA.id,
            write: false,
            clientProtocol: 3,
          }),
        ),
      ).toBe("FORBIDDEN");
    });

    it("finding: a deleted repo is no longer reachable by id", async () => {
      await asOwner.repo.deleteRepo({ id: repoA.id });

      expect(await codeOf(asOwner.repo.getRepo({ id: repoA.id }))).toBe(
        "NOT_FOUND",
      );
      expect(
        await codeOf(
          asWriter.storage.getToken({
            repoId: repoA.id,
            write: true,
            clientProtocol: 3,
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("finding: a deleted org's repos are no longer reachable", async () => {
      await asOwner.org.deleteOrg({ id: orgA.id });

      expect(await codeOf(asWriter.repo.getRepo({ id: repoA.id }))).toBe(
        "NOT_FOUND",
      );
      expect(
        await codeOf(
          asWriter.storage.getToken({
            repoId: repoA.id,
            write: true,
            clientProtocol: 3,
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("finding: file.getFiles does not return another repo's files by id", async () => {
      const foreign = await makeFile(db, repoB.id, "secret/plan.txt");

      const files = await asReader.file.getFiles({
        repoId: repoA.id,
        ids: [foreign.id],
      });
      expect(files).toEqual([]);
    });
  });

  // ── Workspaces and claims ───────────────────────────────────────

  describe("workspaces and claims", () => {
    it("control: another user's workspace is refused", async () => {
      const ws = await makeWorkspace(db, repoA.id, orgA.id, owner.id);

      expect(
        await codeOf(asWriter.workspace.getBranchState({ workspaceId: ws.id })),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(
          asWriter.workspace.updateSyncStatus({
            workspaceId: ws.id,
            changelistNumber: 0,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(
          asWriter.file.checkout({
            repoId: repoA.id,
            workspaceId: ws.id,
            filePath: "a.txt",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(
          asWriter.file.getWorkspaceClaims({
            repoId: repoA.id,
            workspaceId: ws.id,
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("control: one user cannot release another user's claim", async () => {
      const ownerWs = await makeWorkspace(db, repoA.id, orgA.id, owner.id);
      const writerWs = await makeWorkspace(db, repoA.id, orgA.id, writer.id);
      await asOwner.file.checkout({
        repoId: repoA.id,
        workspaceId: ownerWs.id,
        filePath: "art/hero.uasset",
      });

      // Through the owner's workspace: not theirs.
      expect(
        await codeOf(
          asWriter.file.releaseClaim({
            repoId: repoA.id,
            workspaceId: ownerWs.id,
            filePath: "art/hero.uasset",
          }),
        ),
      ).toBe("NOT_FOUND");
      // Through their own workspace: it holds no claim on the file.
      expect(
        await codeOf(
          asWriter.file.releaseClaim({
            repoId: repoA.id,
            workspaceId: writerWs.id,
            filePath: "art/hero.uasset",
          }),
        ),
      ).toBe("NOT_FOUND");
      // Force release is for repo admins.
      const claim = await db.fileClaim.findFirstOrThrow({
        where: { workspaceId: ownerWs.id },
      });
      expect(
        await codeOf(
          asWriter.file.forceReleaseClaim({
            repoId: repoA.id,
            claimId: claim.id,
          }),
        ),
      ).toBe("FORBIDDEN");
      // Nor can a repo admin of another org force-release it via their repo.
      expect(
        await codeOf(
          asOwnerB.file.forceReleaseClaim({
            repoId: repoB.id,
            claimId: claim.id,
          }),
        ),
      ).toBe("NOT_FOUND");

      const still = await db.fileClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(still.releasedAt).toBeNull();
    });

    it("finding: a workspace from one repo cannot be used in another", async () => {
      // The writer owns a workspace in repo A and has write on repo C too.
      const repoC = await makeRepo(db, orgA.id, owner.id);
      await db.repoRole.create({
        data: { repoId: repoC.id, userId: writer.id, access: "WRITE" },
      });
      const wsInA = await makeWorkspace(db, repoA.id, orgA.id, writer.id);

      expect(
        await codeOf(
          asWriter.file.checkout({
            repoId: repoC.id,
            workspaceId: wsInA.id,
            filePath: "a.uasset",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(
          asWriter.changelist.createChangelist({
            repoId: repoC.id,
            workspaceId: wsInA.id,
            branchName: "main",
            message: "x",
            versionIndex: "",
            modifications: [],
            keepCheckedOut: false,
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("control: a workspace can only be created on a repo you can read", async () => {
      expect(
        await codeOf(
          asOwner.workspace.create({
            name: "w",
            repoId: repoB.id,
            defaultBranchName: "main",
          }),
        ),
      ).toBe("FORBIDDEN");
    });
  });

  // ── Merges and reviews ──────────────────────────────────────────

  describe("merges", () => {
    beforeEach(async () => {
      await makeBranch(db, repoA.id, writer.id, {
        name: "feat",
        parentName: "main",
      });
      // Only the owner may merge into mainline branches.
      await db.mergePermission.create({
        data: { repoId: repoA.id, userId: owner.id, type: "MAINLINE" },
      });
    });

    it("finding: a direct branch merge obeys the merge permissions", async () => {
      expect(
        await codeOf(
          asWriter.branch.mergeBranch({
            repoId: repoA.id,
            incomingBranchName: "feat",
            targetBranchName: "main",
          }),
        ),
      ).toBe("FORBIDDEN");
    });

    it("control: a permitted user gets past the merge permissions", async () => {
      const code = await codeOf(
        asOwner.branch.mergeBranch({
          repoId: repoA.id,
          incomingBranchName: "feat",
          targetBranchName: "main",
        }),
      );
      expect(code).not.toBe("FORBIDDEN");
    });

    it("control: a merge request's merge obeys the merge permissions", async () => {
      const mr = await asWriter.mergeRequest.create({
        repoId: repoA.id,
        title: "feat",
        sourceBranchName: "feat",
        targetBranchName: "main",
      });
      expect(
        await codeOf(
          asWriter.mergeRequest.merge({ repoId: repoA.id, number: mr.number }),
        ),
      ).toBe("FORBIDDEN");
    });

    it("finding: requesting a review cannot clear another reviewer's REQUEST_CHANGES", async () => {
      const mr = await asWriter.mergeRequest.create({
        repoId: repoA.id,
        title: "feat",
        sourceBranchName: "feat",
        targetBranchName: "main",
      });
      await asOwner.mergeRequest.addReview({
        repoId: repoA.id,
        mrNumber: mr.number,
        reviewerId: owner.id,
        state: "REQUEST_CHANGES",
      });

      // The author "re-requests" a review from the blocker.
      await asWriter.mergeRequest.addReview({
        repoId: repoA.id,
        mrNumber: mr.number,
        reviewerId: owner.id,
        state: "PENDING",
      });

      const review = await db.mergeRequestReview.findFirstOrThrow({
        where: { mergeRequestId: mr.id, reviewerId: owner.id },
      });
      expect(review.state).toBe("REQUEST_CHANGES");
    });

    it("finding: a reviewer must be able to read the repo", async () => {
      const mr = await asWriter.mergeRequest.create({
        repoId: repoA.id,
        title: "feat",
        sourceBranchName: "feat",
        targetBranchName: "main",
      });
      expect(
        await codeOf(
          asWriter.mergeRequest.addReview({
            repoId: repoA.id,
            mrNumber: mr.number,
            reviewerId: outsider.id,
            state: "PENDING",
          }),
        ),
      ).toBe("BAD_REQUEST");
      expect(
        await db.notification.count({ where: { userId: outsider.id } }),
      ).toBe(0);
    });

    it("control: only the reviewer can approve, and not on their own MR", async () => {
      const mr = await asWriter.mergeRequest.create({
        repoId: repoA.id,
        title: "feat",
        sourceBranchName: "feat",
        targetBranchName: "main",
      });
      expect(
        await codeOf(
          asWriter.mergeRequest.addReview({
            repoId: repoA.id,
            mrNumber: mr.number,
            reviewerId: owner.id,
            state: "APPROVED",
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(
          asWriter.mergeRequest.addReview({
            repoId: repoA.id,
            mrNumber: mr.number,
            reviewerId: writer.id,
            state: "APPROVED",
          }),
        ),
      ).toBe("BAD_REQUEST");
    });
  });

  // ── Issues and notifications ────────────────────────────────────

  describe("issues and notifications", () => {
    it("finding: issue.countOpen needs read access", async () => {
      expect(await codeOf(asOutsider.issue.countOpen({ repoId: repoA.id }))).toBe(
        "FORBIDDEN",
      );
      expect(await asReader.issue.countOpen({ repoId: repoA.id })).toBe(0);
    });

    it("finding: an issue cannot carry another repo's label", async () => {
      const foreignLabel = await db.issueLabel.create({
        data: { repoId: repoB.id, name: "acquisition-target" },
      });

      expect(
        await codeOf(
          asWriter.issue.create({
            repoId: repoA.id,
            title: "t",
            labelIds: [foreignLabel.id],
          }),
        ),
      ).toBe("NOT_FOUND");

      const issue = await asWriter.issue.create({ repoId: repoA.id, title: "t" });
      expect(
        await codeOf(
          asWriter.issue.addLabelToIssue({
            issueId: issue.id,
            labelId: foreignLabel.id,
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("finding: an outsider cannot be assigned (and so notified) on a private repo's issue", async () => {
      expect(
        await codeOf(
          asWriter.issue.create({
            repoId: repoA.id,
            title: "t",
            assigneeIds: [outsider.id],
          }),
        ),
      ).toBe("BAD_REQUEST");

      const issue = await asWriter.issue.create({ repoId: repoA.id, title: "t" });
      expect(
        await codeOf(
          asWriter.issue.addAssignee({ issueId: issue.id, userId: outsider.id }),
        ),
      ).toBe("BAD_REQUEST");
      expect(
        await db.notification.count({ where: { userId: outsider.id } }),
      ).toBe(0);

      // A member who can read is fine.
      await asWriter.issue.addAssignee({ issueId: issue.id, userId: reader.id });
    });

    it("finding: notifications reach only subscribers who can still read the repo", async () => {
      const notifications = await vi.importActual<
        typeof import("~/server/notifications")
      >("~/server/notifications");

      const issue = await db.issue.create({
        data: { repoId: repoA.id, number: 1, title: "t", authorId: writer.id },
      });
      const mr = await db.mergeRequest.create({
        data: {
          repoId: repoA.id,
          number: 1,
          title: "t",
          sourceBranchName: "feat",
          targetBranchName: "main",
          authorId: writer.id,
        },
      });
      // A member, an outsider subscribed somehow, and a member since removed.
      const removed = await makeUser(db);
      for (const userId of [reader.id, outsider.id, removed.id]) {
        await db.issueSubscription.create({ data: { issueId: issue.id, userId } });
        await db.mergeRequestSubscription.create({
          data: { mergeRequestId: mr.id, userId },
        });
      }

      await notifications.notifyIssueSubscribers({
        db,
        actorId: writer.id,
        issueId: issue.id,
        type: "issue_comment",
        title: "Comment on #1",
        body: "the private plan",
        link: "/x",
      });
      await notifications.notifyMRSubscribers({
        db,
        actorId: writer.id,
        mergeRequestId: mr.id,
        type: "mr_comment",
        title: "Comment on MR #1",
        body: "the private plan",
        link: "/x",
      });

      const recipients = await db.notification.findMany({
        select: { userId: true },
      });
      expect(recipients.map((r) => r.userId).sort()).toEqual(
        [reader.id, reader.id].sort(),
      );
    });

    it("finding: an @mention of someone outside the repo does not deliver its content", async () => {
      const notifications = await vi.importActual<
        typeof import("~/server/notifications")
      >("~/server/notifications");
      await db.user.update({
        where: { id: outsider.id },
        data: { username: "outsider_handle" },
      });
      const issue = await db.issue.create({
        data: { repoId: repoA.id, number: 1, title: "t", authorId: writer.id },
      });

      await notifications.notifyIssueSubscribers({
        db,
        actorId: writer.id,
        issueId: issue.id,
        type: "issue_comment",
        title: "Comment on #1",
        body: "hey @outsider_handle",
        link: "/x",
        text: "hey @outsider_handle",
      });

      expect(
        await db.notification.count({ where: { userId: outsider.id } }),
      ).toBe(0);
    });
  });

  // ── API tokens and device pairing ───────────────────────────────

  describe("API tokens", () => {
    async function sessionFor(token: string) {
      const { createTRPCContext } = await import("~/server/api/trpc");
      const ctx = await createTRPCContext({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      return ctx.session;
    }

    it("control: a valid token authenticates as its owner", async () => {
      const { token } = await makeApiToken(db, writer.id);
      expect((await sessionFor(token))?.user.id).toBe(writer.id);
    });

    it("control: an expired token does not authenticate", async () => {
      const { token } = await makeApiToken(db, writer.id, {
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await sessionFor(token)).toBeNull();
    });

    it("control: a revoked device token stops working, and only its owner can revoke it", async () => {
      const { id, token } = await makeApiToken(db, writer.id);

      expect(
        await codeOf(asOutsider.apiToken.revokeDevice({ deviceId: id })),
      ).not.toBe("OK");
      expect((await sessionFor(token))?.user.id).toBe(writer.id);

      await asWriter.apiToken.revokeDevice({ deviceId: id });
      expect(await sessionFor(token)).toBeNull();
    });

    it("control: listing devices does not reveal token secrets or other users' devices", async () => {
      await makeApiToken(db, writer.id, { deviceCode: "ABC123" });
      await makeApiToken(db, outsider.id);

      const { activeDevices } = await asWriter.apiToken.getActiveDevices();
      expect(activeDevices).toHaveLength(1);
      expect(activeDevices[0]!.token).toBe("");
      expect(activeDevices[0]!.deviceCode).toBeNull();
    });

    it("finding: a device code stops working once its pairing window has passed", async () => {
      const { id } = await makeApiToken(db, writer.id, { deviceCode: "OLD123" });
      await db.apiToken.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
      });

      const anon = await makeAppCaller();
      expect(
        await codeOf(anon.apiToken.getApiToken({ code: "OLD123" })),
      ).toBe("NOT_FOUND");
    });

    it("control: a device code works once, within its window", async () => {
      const { token } = await makeApiToken(db, writer.id, {
        deviceCode: "NEW123",
      });
      const anon = await makeAppCaller();

      const first = await anon.apiToken.getApiToken({ code: "NEW123" });
      expect(first.apiToken).toBe(token);
      expect(
        await codeOf(anon.apiToken.getApiToken({ code: "NEW123" })),
      ).toBe("NOT_FOUND");
    });
  });

  // ── Storage tokens ──────────────────────────────────────────────

  describe("storage tokens", () => {
    it("control: a storage token is scoped to its repo, its mode, and its lifetime", async () => {
      const read = await asReader.storage.getToken({
        repoId: repoA.id,
        write: false,
        clientProtocol: 3,
      });
      const verified = verifyRepoToken(`Bearer ${read.token}`, false);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.basePath).toBe(`/${orgA.id}/${repoA.id}`);
      expect(verified.claims.userId).toBe(reader.id);

      // A read token is not a write token.
      expect(verifyRepoToken(`Bearer ${read.token}`, true).ok).toBe(false);

      // And a token past its expiry is refused.
      const expired = njwt.create(
        { ...verified.claims },
        await storageSigningKey(),
      );
      expired.setExpiration(Date.now() - 1000);
      expect(verifyRepoToken(`Bearer ${expired.compact()}`, false).ok).toBe(
        false,
      );
    });

    it("control: a system token is not a repo token", async () => {
      const system = njwt.create(
        { iss: "checkpoint-api", system: true, action: "mkdir", path: "/x" },
        await storageSigningKey(),
      );
      expect(verifyRepoToken(`Bearer ${system.compact()}`, false).ok).toBe(
        false,
      );
    });

    it("control: repo B's owner cannot get a token for repo A", async () => {
      expect(
        await codeOf(
          asOwnerB.storage.getToken({
            repoId: repoA.id,
            write: false,
            clientProtocol: 3,
          }),
        ),
      ).toBe("FORBIDDEN");
    });
  });

  // ── REST routes ─────────────────────────────────────────────────

  describe("GET /api/file/download", () => {
    async function download(user: TestUser | null, repoId: string) {
      vi.mocked(getSession).mockResolvedValue(
        user
          ? {
              user: { id: user.id, email: user.email },
              expires: new Date(Date.now() + 60_000).toISOString(),
            }
          : null,
      );
      const { GET } = await import("~/app/api/file/download/route");
      const url = new URL(
        `http://app.test/api/file/download?repoId=${repoId}&cl=1&path=secret.txt`,
      );
      return GET({ nextUrl: url } as unknown as NextRequest);
    }

    beforeEach(async () => {
      setConfig("logging.longtail-level", "error");
      await db.changelist.create({
        data: {
          repoId: repoA.id,
          number: 1,
          message: "m",
          versionIndex: `${"a".repeat(64)}.lvi`,
          userId: owner.id,
        },
      });
    });

    it("finding: refuses a signed-in user with no access to the repo", async () => {
      const res = await download(ownerB, repoA.id);
      expect(res.status).toBe(403);
    });

    it("control: refuses an anonymous request", async () => {
      const res = await download(null, repoA.id);
      expect(res.status).toBe(401);
    });

    it("control: serves a member who can read the repo", async () => {
      const res = await download(reader, repoA.id);
      expect(res.status).toBe(200);
    });
  });

  // ── Integrations ────────────────────────────────────────────────

  describe("issue tracker config", () => {
    beforeEach(async () => {
      await db.repo.update({
        where: { id: repoA.id },
        data: { issuesPlatform: "JIRA" },
      });
      await db.repoIssueTrackerConfig.create({
        data: {
          repoId: repoA.id,
          jiraBaseUrl: "https://acme.atlassian.net",
          jiraEmail: "ci@acme.test",
          jiraProjectKey: "ACME",
          encryptedToken: "v1:stored",
        },
      });
    });

    it("finding: the stored token is not kept when the Jira URL is repointed", async () => {
      const code = await codeOf(
        asOwner.issueTracker.updateConfig({
          repoId: repoA.id,
          platform: "JIRA",
          jiraBaseUrl: "https://collector.evil.test",
          jiraEmail: "ci@acme.test",
          jiraProjectKey: "ACME",
        }),
      );
      expect(code).toBe("BAD_REQUEST");

      const row = await db.repoIssueTrackerConfig.findUniqueOrThrow({
        where: { repoId: repoA.id },
      });
      expect(row.jiraBaseUrl).toBe("https://acme.atlassian.net");
    });

    it("control: other fields can change without re-entering the token", async () => {
      await asOwner.issueTracker.updateConfig({
        repoId: repoA.id,
        platform: "JIRA",
        jiraBaseUrl: "https://acme.atlassian.net/",
        jiraEmail: "ci@acme.test",
        jiraProjectKey: "GAME",
      });
      const row = await db.repoIssueTrackerConfig.findUniqueOrThrow({
        where: { repoId: repoA.id },
      });
      expect(row.jiraProjectKey).toBe("GAME");
      expect(row.encryptedToken).toBe("v1:stored");
    });

    it("control: the config and its secret are for repo admins only", async () => {
      expect(
        await codeOf(asWriter.issueTracker.getConfig({ repoId: repoA.id })),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(
          asWriter.issueTracker.testConnection({ repoId: repoA.id }),
        ),
      ).toBe("FORBIDDEN");
      const config = await asOwner.issueTracker.getConfig({ repoId: repoA.id });
      expect(config).not.toHaveProperty("encryptedToken");
      expect(config.hasToken).toBe(true);
    });
  });
});
