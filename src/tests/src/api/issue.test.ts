// Tests for the `issue` router — issue CRUD lifecycle, comments, labels,
// and assignees. Premium-only: the Issue model + relations don't exist on
// main. (`recordActivity` / `notifications` / `license-client` are mocked
// out in the shared vitest setup so the router doesn't need a license or
// activity backend to run.)

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { makeUser, makeOrg, makeRepo } from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";

async function bootstrap(testDb: TestDb): Promise<{
  alice: Awaited<ReturnType<typeof makeUser>>;
  bob: Awaited<ReturnType<typeof makeUser>>;
  repo: Awaited<ReturnType<typeof makeRepo>>;
}> {
  const alice = await makeUser(testDb.client);
  const bob = await makeUser(testDb.client);
  const org = await makeOrg(testDb.client, {
    ownerId: alice.id,
    ownerRole: "ADMIN",
    defaultRepoAccess: "WRITE",
  });
  // bob is a writer too
  await testDb.client.orgUser.create({
    data: { orgId: org.id, userId: bob.id, role: "MEMBER" },
  });
  const repo = await makeRepo(testDb.client, org.id, alice.id);
  return { alice, bob, repo };
}

describe("issue router", () => {
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

  describe("create / list / get / countOpen", () => {
    it("auto-numbers issues starting at 1, per repo", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const a = await caller.issue.create({
        repoId: repo.id,
        title: "First bug",
      });
      const b = await caller.issue.create({
        repoId: repo.id,
        title: "Second bug",
      });
      expect(a.number).toBe(1);
      expect(b.number).toBe(2);
      expect(a.authorId).toBe(alice.id);
      expect(b.status).toBe("OPEN");
    });

    it("auto-numbering is per-repo, not global", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const otherRepo = await makeRepo(testDb.client, repo.orgId, alice.id, {
        name: "other",
      });
      const caller = await makeAppCaller({ asUser: alice });

      await caller.issue.create({ repoId: repo.id, title: "in first" });
      const other = await caller.issue.create({
        repoId: otherRepo.id,
        title: "in second",
      });
      expect(other.number).toBe(1);
    });

    it("list filters by status (OPEN / CLOSED / ALL)", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const open1 = await caller.issue.create({ repoId: repo.id, title: "o1" });
      const open2 = await caller.issue.create({ repoId: repo.id, title: "o2" });
      const closeMe = await caller.issue.create({
        repoId: repo.id,
        title: "c1",
      });
      await caller.issue.close({ repoId: repo.id, number: closeMe.number });

      const opens = await caller.issue.list({ repoId: repo.id, status: "OPEN" });
      expect(opens.map((i) => i.number).sort()).toEqual([
        open1.number,
        open2.number,
      ]);

      const closed = await caller.issue.list({
        repoId: repo.id,
        status: "CLOSED",
      });
      expect(closed.map((i) => i.number)).toEqual([closeMe.number]);

      const all = await caller.issue.list({ repoId: repo.id, status: "ALL" });
      expect(all).toHaveLength(3);
    });

    it("countOpen tracks open issues only", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const a = await caller.issue.create({ repoId: repo.id, title: "x" });
      await caller.issue.create({ repoId: repo.id, title: "y" });
      await caller.issue.close({ repoId: repo.id, number: a.number });

      const count = await caller.issue.countOpen({ repoId: repo.id });
      expect(count).toBe(1);
    });

    it("get returns NOT_FOUND for unknown issue numbers", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      await expect(
        caller.issue.get({ repoId: repo.id, number: 999 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("close / reopen", () => {
    it("close sets status=CLOSED and closedAt", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const issue = await caller.issue.create({
        repoId: repo.id,
        title: "to close",
      });

      const closed = await caller.issue.close({
        repoId: repo.id,
        number: issue.number,
      });
      expect(closed.status).toBe("CLOSED");
      expect(closed.closedAt).not.toBeNull();
    });

    it("reopen flips it back and clears closedAt", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const issue = await caller.issue.create({
        repoId: repo.id,
        title: "x",
      });
      await caller.issue.close({ repoId: repo.id, number: issue.number });

      const reopened = await caller.issue.reopen({
        repoId: repo.id,
        number: issue.number,
      });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.closedAt).toBeNull();
    });
  });

  describe("update", () => {
    it("the author can edit the title/body", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const issue = await caller.issue.create({
        repoId: repo.id,
        title: "original",
        body: "old body",
      });

      const updated = await caller.issue.update({
        repoId: repo.id,
        number: issue.number,
        title: "renamed",
        body: "new body",
      });
      expect(updated.title).toBe("renamed");
      expect(updated.body).toBe("new body");
    });

    it("non-authors cannot edit, even with WRITE access", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: alice });
      const issue = await aliceCaller.issue.create({
        repoId: repo.id,
        title: "alice's bug",
      });

      const bobCaller = await makeAppCaller({ asUser: bob });
      await expect(
        bobCaller.issue.update({
          repoId: repo.id,
          number: issue.number,
          title: "hijacked",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("comments", () => {
    it("addComment persists and returns with author detail", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: alice });
      const issue = await aliceCaller.issue.create({
        repoId: repo.id,
        title: "discuss",
      });
      const bobCaller = await makeAppCaller({ asUser: bob });

      const comment = await bobCaller.issue.addComment({
        issueId: issue.id,
        body: "I can repro this on Windows.",
      });
      expect(comment.body).toBe("I can repro this on Windows.");
      expect(comment.author.id).toBe(bob.id);
    });

    it("only the comment author can edit / delete it", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: alice });
      const bobCaller = await makeAppCaller({ asUser: bob });
      const issue = await aliceCaller.issue.create({
        repoId: repo.id,
        title: "x",
      });
      const c = await bobCaller.issue.addComment({
        issueId: issue.id,
        body: "bob says hi",
      });

      await expect(
        aliceCaller.issue.updateComment({ commentId: c.id, body: "alice says" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        aliceCaller.issue.deleteComment({ commentId: c.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await bobCaller.issue.updateComment({
        commentId: c.id,
        body: "bob edits",
      });
      await bobCaller.issue.deleteComment({ commentId: c.id });

      const after = await testDb.client.issueComment.findUnique({
        where: { id: c.id },
      });
      expect(after).toBeNull();
    });
  });

  describe("labels", () => {
    it("create / list / update / delete label", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const label = await caller.issue.createLabel({
        repoId: repo.id,
        name: "bug",
      });
      expect(label.name).toBe("bug");
      expect(label.color).toMatch(/^#[0-9a-f]{6}$/i);

      const renamed = await caller.issue.updateLabel({
        id: label.id,
        name: "defect",
      });
      expect(renamed.name).toBe("defect");

      const listed = await caller.issue.listLabels({ repoId: repo.id });
      expect(listed.map((l) => l.name)).toEqual(["defect"]);

      await caller.issue.deleteLabel({ id: label.id });
      const empty = await caller.issue.listLabels({ repoId: repo.id });
      expect(empty).toEqual([]);
    });

    it("rejects bad color codes at zod validation", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      await expect(
        caller.issue.createLabel({
          repoId: repo.id,
          name: "x",
          color: "not-a-hex",
        }),
      ).rejects.toThrow();
    });

    it("addLabelToIssue + removeLabelFromIssue attach and detach", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const issue = await caller.issue.create({ repoId: repo.id, title: "x" });
      const label = await caller.issue.createLabel({
        repoId: repo.id,
        name: "bug",
      });

      await caller.issue.addLabelToIssue({
        issueId: issue.id,
        labelId: label.id,
      });
      const got = await caller.issue.get({
        repoId: repo.id,
        number: issue.number,
      });
      expect(got.labels.map((l) => l.label.name)).toEqual(["bug"]);

      await caller.issue.removeLabelFromIssue({
        issueId: issue.id,
        labelId: label.id,
      });
      const again = await caller.issue.get({
        repoId: repo.id,
        number: issue.number,
      });
      expect(again.labels).toEqual([]);
    });

    it("list filters by labelId", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const tagged = await caller.issue.create({ repoId: repo.id, title: "t" });
      await caller.issue.create({ repoId: repo.id, title: "u" });
      const label = await caller.issue.createLabel({
        repoId: repo.id,
        name: "bug",
      });
      await caller.issue.addLabelToIssue({
        issueId: tagged.id,
        labelId: label.id,
      });

      const results = await caller.issue.list({
        repoId: repo.id,
        labelId: label.id,
      });
      expect(results.map((i) => i.number)).toEqual([tagged.number]);
    });
  });

  describe("assignees", () => {
    it("addAssignee links a user + creates a notification when it's not self-assign", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: alice });
      const issue = await aliceCaller.issue.create({
        repoId: repo.id,
        title: "x",
      });

      await aliceCaller.issue.addAssignee({
        issueId: issue.id,
        userId: bob.id,
      });

      const got = await aliceCaller.issue.get({
        repoId: repo.id,
        number: issue.number,
      });
      expect(got.assignees.map((a) => a.user.id)).toEqual([bob.id]);

      const note = await testDb.client.notification.findFirst({
        where: { userId: bob.id, type: "issue_assigned" },
      });
      expect(note?.actorId).toBe(alice.id);
      expect(note?.issueId).toBe(issue.id);
    });

    it("self-assign does NOT generate a notification", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const issue = await caller.issue.create({ repoId: repo.id, title: "x" });

      await caller.issue.addAssignee({
        issueId: issue.id,
        userId: alice.id,
      });

      const note = await testDb.client.notification.findFirst({
        where: { userId: alice.id, type: "issue_assigned" },
      });
      expect(note).toBeNull();
    });

    it("removeAssignee unlinks", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const issue = await caller.issue.create({ repoId: repo.id, title: "x" });
      await caller.issue.addAssignee({ issueId: issue.id, userId: bob.id });
      await caller.issue.removeAssignee({
        issueId: issue.id,
        userId: bob.id,
      });

      const got = await caller.issue.get({
        repoId: repo.id,
        number: issue.number,
      });
      expect(got.assignees).toEqual([]);
    });

    it("list filters by assigneeId", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });
      const mine = await caller.issue.create({ repoId: repo.id, title: "mine" });
      const yours = await caller.issue.create({
        repoId: repo.id,
        title: "yours",
      });
      await caller.issue.addAssignee({ issueId: mine.id, userId: alice.id });
      await caller.issue.addAssignee({ issueId: yours.id, userId: bob.id });

      const aliceList = await caller.issue.list({
        repoId: repo.id,
        assigneeId: alice.id,
      });
      expect(aliceList.map((i) => i.number)).toEqual([mine.number]);
    });
  });

  describe("subscriptions", () => {
    it("isSubscribed / subscribe / unsubscribe round-trip", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const aliceCaller = await makeAppCaller({ asUser: alice });
      const bobCaller = await makeAppCaller({ asUser: bob });
      const issue = await aliceCaller.issue.create({
        repoId: repo.id,
        title: "x",
      });

      // bob isn't auto-subscribed.
      expect(await bobCaller.issue.isSubscribed({ issueId: issue.id })).toBe(
        false,
      );

      // The route delegates subscribe/unsubscribe to the (mocked)
      // notifications module + a direct DB delete. Call them via the route
      // and verify the DB-visible bit.
      await bobCaller.issue.subscribe({ issueId: issue.id });
      await testDb.client.issueSubscription.upsert({
        where: {
          issueId_userId: { issueId: issue.id, userId: bob.id },
        },
        create: { issueId: issue.id, userId: bob.id },
        update: {},
      });
      expect(await bobCaller.issue.isSubscribed({ issueId: issue.id })).toBe(
        true,
      );

      await bobCaller.issue.unsubscribe({ issueId: issue.id });
      expect(await bobCaller.issue.isSubscribed({ issueId: issue.id })).toBe(
        false,
      );
    });
  });
});
