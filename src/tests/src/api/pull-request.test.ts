// Tests for the `pullRequest` router — create lifecycle, branch validation,
// comments, and the review state machine. Premium-only.
//
// `merge` is intentionally skipped here — it walks/creates changelists
// across branches and is its own ~200-line procedure; worth a dedicated
// test file later if/when the merge logic changes.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import {
  makeUser,
  makeOrg,
  makeRepo,
  makeBranch,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

interface World {
  alice: Awaited<ReturnType<typeof makeUser>>;
  bob: Awaited<ReturnType<typeof makeUser>>;
  repo: Awaited<ReturnType<typeof makeRepo>>;
  feature: { name: string };
}

async function bootstrap(testDb: TestDb): Promise<World> {
  const alice = await makeUser(testDb.client);
  const bob = await makeUser(testDb.client);
  const org = await makeOrg(testDb.client, {
    ownerId: alice.id,
    ownerRole: "ADMIN",
    defaultRepoAccess: "WRITE",
  });
  await testDb.client.orgUser.create({
    data: { orgId: org.id, userId: bob.id, role: "MEMBER" },
  });
  const repo = await makeRepo(testDb.client, org.id, alice.id);
  // makeRepo creates main MAINLINE; add a feature branch off it.
  const feature = await makeBranch(testDb.client, repo.id, alice.id, {
    name: "feature/x",
    type: "FEATURE",
    parentName: "main",
  });
  return { alice, bob, repo, feature };
}

describe("pullRequest router", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    globalThis.__checkpointTestDb = testDb.client;
  }, 120_000);

  afterAll(async () => {
    await testDb.teardown();
    delete globalThis.__checkpointTestDb;
  });

  beforeEach(async () => {
    await testDb.reset();
  });

  describe("create", () => {
    it("auto-numbers from 1 and persists the PR", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });

      const pr = await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "Add feature",
        description: "desc",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      expect(pr.number).toBe(1);
      expect(pr.status).toBe("OPEN");
      expect(pr.authorId).toBe(w.alice.id);
      expect(pr.sourceBranchName).toBe(w.feature.name);
      expect(pr.targetBranchName).toBe("main");
    });

    it("rejects when source branch is not a FEATURE branch", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      // main → main: source is MAINLINE, not FEATURE
      await expect(
        caller.pullRequest.create({
          repoId: w.repo.id,
          title: "x",
          sourceBranchName: "main",
          targetBranchName: "main",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects when source's parent isn't the target", async () => {
      const w = await bootstrap(testDb);
      // Create a second FEATURE off main; PR from it into feature/x would
      // skip the parent-equals-target check.
      await makeBranch(testDb.client, w.repo.id, w.alice.id, {
        name: "feature/y",
        type: "FEATURE",
        parentName: "main",
      });
      const caller = await makeAppCaller({ asUser: w.alice });

      await expect(
        caller.pullRequest.create({
          repoId: w.repo.id,
          title: "x",
          sourceBranchName: "feature/y",
          targetBranchName: w.feature.name, // not the parent
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects unknown branches with NOT_FOUND", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      await expect(
        caller.pullRequest.create({
          repoId: w.repo.id,
          title: "x",
          sourceBranchName: "ghost",
          targetBranchName: "main",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a second open PR off the same source branch with CONFLICT", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "first",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      await expect(
        caller.pullRequest.create({
          repoId: w.repo.id,
          title: "second",
          sourceBranchName: w.feature.name,
          targetBranchName: "main",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("allows a new PR off the same branch once the previous one is closed", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      const first = await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "first",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      await caller.pullRequest.close({
        repoId: w.repo.id,
        number: first.number,
      });

      const second = await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "second",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      expect(second.number).toBe(2);
    });
  });

  describe("close / reopen", () => {
    it("close flips status, sets closedAt; reopen flips back and clears it", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      const pr = await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      const closed = await caller.pullRequest.close({
        repoId: w.repo.id,
        number: pr.number,
      });
      expect(closed.status).toBe("CLOSED");
      expect(closed.closedAt).not.toBeNull();

      const reopened = await caller.pullRequest.reopen({
        repoId: w.repo.id,
        number: pr.number,
      });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.closedAt).toBeNull();
    });

    it("close rejects an already-closed PR", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      const pr = await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      await caller.pullRequest.close({ repoId: w.repo.id, number: pr.number });

      await expect(
        caller.pullRequest.close({ repoId: w.repo.id, number: pr.number }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("update", () => {
    it("the author can edit title/description; others can't", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const bobCaller = await makeAppCaller({ asUser: w.bob });
      const pr = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      const updated = await aliceCaller.pullRequest.update({
        repoId: w.repo.id,
        number: pr.number,
        title: "x prime",
        description: "new",
      });
      expect(updated.title).toBe("x prime");
      expect(updated.description).toBe("new");

      await expect(
        bobCaller.pullRequest.update({
          repoId: w.repo.id,
          number: pr.number,
          title: "hijacked",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("countOpen / list", () => {
    it("countOpen counts only OPEN PRs", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const pr1 = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "pr1",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      await aliceCaller.pullRequest.close({
        repoId: w.repo.id,
        number: pr1.number,
      });
      // 2nd PR off another feature branch
      await makeBranch(testDb.client, w.repo.id, w.alice.id, {
        name: "feature/z",
        type: "FEATURE",
        parentName: "main",
      });
      await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "pr2",
        sourceBranchName: "feature/z",
        targetBranchName: "main",
      });

      const count = await aliceCaller.pullRequest.countOpen({
        repoId: w.repo.id,
      });
      expect(count).toBe(1);
    });
  });

  describe("comments", () => {
    it("addComment persists with author detail; non-author can't update/delete", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const bobCaller = await makeAppCaller({ asUser: w.bob });
      const pr = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      const c = await bobCaller.pullRequest.addComment({
        repoId: w.repo.id,
        prNumber: pr.number,
        body: "looks good",
      });
      expect(c.body).toBe("looks good");
      expect(c.author.id).toBe(w.bob.id);

      await expect(
        aliceCaller.pullRequest.updateComment({
          commentId: c.id,
          body: "hijacked",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        aliceCaller.pullRequest.deleteComment({ commentId: c.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await bobCaller.pullRequest.updateComment({
        commentId: c.id,
        body: "amended",
      });
      await bobCaller.pullRequest.deleteComment({ commentId: c.id });

      const after = await testDb.client.pullRequestComment.findUnique({
        where: { id: c.id },
      });
      expect(after).toBeNull();
    });
  });

  describe("addReview state machine", () => {
    it("requesting a PENDING review on someone else creates a notification", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const pr = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      await aliceCaller.pullRequest.addReview({
        repoId: w.repo.id,
        prNumber: pr.number,
        reviewerId: w.bob.id,
        state: "PENDING",
      });

      const note = await testDb.client.notification.findFirst({
        where: { userId: w.bob.id, type: "pr_review_requested" },
      });
      expect(note?.actorId).toBe(w.alice.id);
      expect(note?.pullRequestId).toBe(pr.id);
    });

    it("the author cannot APPROVE their own PR", async () => {
      const w = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: w.alice });
      const pr = await caller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      await expect(
        caller.pullRequest.addReview({
          repoId: w.repo.id,
          prNumber: pr.number,
          reviewerId: w.alice.id,
          state: "APPROVED",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("only the reviewer themselves can set APPROVED / REQUEST_CHANGES", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const pr = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      // alice tries to mark bob's review APPROVED — not allowed.
      await expect(
        aliceCaller.pullRequest.addReview({
          repoId: w.repo.id,
          prNumber: pr.number,
          reviewerId: w.bob.id,
          state: "APPROVED",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("upserts on (pr, reviewer): a second call updates the existing row", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const bobCaller = await makeAppCaller({ asUser: w.bob });
      const pr = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });

      // alice requests bob's review (PENDING)
      await aliceCaller.pullRequest.addReview({
        repoId: w.repo.id,
        prNumber: pr.number,
        reviewerId: w.bob.id,
        state: "PENDING",
      });

      // bob approves
      await bobCaller.pullRequest.addReview({
        repoId: w.repo.id,
        prNumber: pr.number,
        reviewerId: w.bob.id,
        state: "APPROVED",
      });

      const reviews = await testDb.client.pullRequestReview.findMany({
        where: { pullRequestId: pr.id, reviewerId: w.bob.id },
      });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.state).toBe("APPROVED");
    });

    it("APPROVED on a closed PR is rejected", async () => {
      const w = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: w.alice });
      const bobCaller = await makeAppCaller({ asUser: w.bob });
      const pr = await aliceCaller.pullRequest.create({
        repoId: w.repo.id,
        title: "x",
        sourceBranchName: w.feature.name,
        targetBranchName: "main",
      });
      await aliceCaller.pullRequest.close({
        repoId: w.repo.id,
        number: pr.number,
      });

      await expect(
        bobCaller.pullRequest.addReview({
          repoId: w.repo.id,
          prNumber: pr.number,
          reviewerId: w.bob.id,
          state: "APPROVED",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });
});
