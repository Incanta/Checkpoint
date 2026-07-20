// Tests for the `issueTracker` router: per-repo issues platform config,
// encrypted token handling (tokens must never appear in any response), link
// info for "#<id>" mention resolution, and access control. External API
// fetches are not exercised here (they need real credentials); the adapter
// URL/tokenizer logic is covered by issue-refs.test.ts.

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

const JIRA_INPUT = {
  platform: "JIRA" as const,
  jiraBaseUrl: "https://acme.atlassian.net",
  jiraEmail: "alice@example.com",
  jiraProjectKey: "PROJ",
  token: "super-secret-jira-token",
};

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
  // bob has write access but is not an admin
  await testDb.client.orgUser.create({
    data: { orgId: org.id, userId: bob.id, role: "MEMBER" },
  });
  const repo = await makeRepo(testDb.client, org.id, alice.id);
  return { alice, bob, repo };
}

describe("issueTracker router", () => {
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

  describe("getConfig / updateConfig", () => {
    it("defaults to CHECKPOINT with no stored token", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const config = await caller.issueTracker.getConfig({ repoId: repo.id });
      expect(config.platform).toBe("CHECKPOINT");
      expect(config.hasToken).toBe(false);
    });

    it("stores Jira config with the token encrypted and never returned", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const result = await caller.issueTracker.updateConfig({
        repoId: repo.id,
        ...JIRA_INPUT,
      });

      expect(result.platform).toBe("JIRA");
      expect(result.jiraBaseUrl).toBe(JIRA_INPUT.jiraBaseUrl);
      expect(result.hasToken).toBe(true);
      // The raw token and the ciphertext must not appear anywhere in the
      // mutation response or in getConfig
      expect(JSON.stringify(result)).not.toContain(JIRA_INPUT.token);
      expect(result).not.toHaveProperty("encryptedToken");

      const fetched = await caller.issueTracker.getConfig({ repoId: repo.id });
      expect(JSON.stringify(fetched)).not.toContain(JIRA_INPUT.token);
      expect(fetched).not.toHaveProperty("encryptedToken");
      expect(fetched.hasToken).toBe(true);

      // The repo row reflects the platform; the stored token is encrypted
      const repoRow = await testDb.client.repo.findUniqueOrThrow({
        where: { id: repo.id },
      });
      expect(repoRow.issuesPlatform).toBe("JIRA");
      const configRow =
        await testDb.client.repoIssueTrackerConfig.findUniqueOrThrow({
          where: { repoId: repo.id },
        });
      expect(configRow.encryptedToken).not.toBeNull();
      expect(configRow.encryptedToken).not.toContain(JIRA_INPUT.token);
      expect(configRow.encryptedToken!.startsWith("v1:")).toBe(true);
    });

    it("keeps the stored token when omitted on a same-platform update", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      await caller.issueTracker.updateConfig({
        repoId: repo.id,
        ...JIRA_INPUT,
      });
      const updated = await caller.issueTracker.updateConfig({
        repoId: repo.id,
        ...JIRA_INPUT,
        jiraProjectKey: "OTHER",
        token: undefined,
      });

      expect(updated.jiraProjectKey).toBe("OTHER");
      expect(updated.hasToken).toBe(true);
    });

    it("does not reuse a stored token across a platform switch", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      await caller.issueTracker.updateConfig({
        repoId: repo.id,
        ...JIRA_INPUT,
      });

      // Switching to HacknPlan without a new key must fail validation
      await expect(
        caller.issueTracker.updateConfig({
          repoId: repo.id,
          platform: "HACKNPLAN",
          hacknplanProjectId: 42,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // With a new key it succeeds, and the old Jira fields are cleared
      const switched = await caller.issueTracker.updateConfig({
        repoId: repo.id,
        platform: "HACKNPLAN",
        hacknplanProjectId: 42,
        token: "hacknplan-key",
      });
      expect(switched.platform).toBe("HACKNPLAN");
      expect(switched.hacknplanProjectId).toBe(42);
      expect(switched.jiraBaseUrl).toBeNull();
      expect(switched.hasToken).toBe(true);
    });

    it("rejects incomplete external config", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      await expect(
        caller.issueTracker.updateConfig({
          repoId: repo.id,
          platform: "JIRA",
          jiraBaseUrl: "https://acme.atlassian.net",
          token: "t",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("round-trips DISABLED and CHECKPOINT without credentials", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      const disabled = await caller.issueTracker.updateConfig({
        repoId: repo.id,
        platform: "DISABLED",
      });
      expect(disabled.platform).toBe("DISABLED");

      const back = await caller.issueTracker.updateConfig({
        repoId: repo.id,
        platform: "CHECKPOINT",
      });
      expect(back.platform).toBe("CHECKPOINT");
      expect(back.hasToken).toBe(false);
    });

    it("requires repo admin access", async () => {
      const { bob, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: bob });

      await expect(
        caller.issueTracker.getConfig({ repoId: repo.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller.issueTracker.updateConfig({
          repoId: repo.id,
          platform: "DISABLED",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("getLinkInfo", () => {
    it("returns the platform and no template for CHECKPOINT", async () => {
      const { bob, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: bob });

      const info = await caller.issueTracker.getLinkInfo({ repoId: repo.id });
      expect(info).toEqual({
        platform: "CHECKPOINT",
        issueUrlTemplate: null,
      });
    });

    it("returns the external URL template to non-admin readers", async () => {
      const { alice, bob, repo } = await bootstrap(testDb);
      const admin = await makeAppCaller({ asUser: alice });
      await admin.issueTracker.updateConfig({ repoId: repo.id, ...JIRA_INPUT });

      const reader = await makeAppCaller({ asUser: bob });
      const info = await reader.issueTracker.getLinkInfo({ repoId: repo.id });
      expect(info.platform).toBe("JIRA");
      expect(info.issueUrlTemplate).toBe(
        "https://acme.atlassian.net/browse/{id}",
      );
      expect(JSON.stringify(info)).not.toContain(JIRA_INPUT.token);
    });
  });

  describe("listExternal", () => {
    it("fails with PRECONDITION_FAILED on a CHECKPOINT repo", async () => {
      const { alice, repo } = await bootstrap(testDb);
      const caller = await makeAppCaller({ asUser: alice });

      await expect(
        caller.issueTracker.listExternal({ repoId: repo.id }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });
  });
});
