// Tests for branch-scoped file claims: domain isolation, the exclusive vs
// advisory split, the claim lifecycle across submits and merges, the freshness
// gate, and stacked-branch reclaim.

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
  makeWorkspace,
  makeFile,
} from "../harness/fixtures";
import { makeAppCaller } from "../harness/caller";
import {
  acquireClaim,
  findActiveExclusiveClaim,
  releaseClaimsForBranch,
  settleClaimAfterLanding,
} from "~/server/claims/claims";
import { settleClaimsForMerge } from "~/server/claims/landing";
import { resolveClaimStrength } from "~/server/claims/strength";
import { resolveDomainBranchName } from "~/server/claims/domain";

const UASSET = "Content/Props/foo.uasset";
const SOURCE = "Source/Game/Player.cpp";

// The org default binary-extension set. `.uasset` is unmergeable and resolves
// to EXCLUSIVE; `.cpp` is mergeable and resolves to ADVISORY.
const NO_OVERRIDES = "";

describe("file claims", () => {
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

  async function scaffold() {
    const owner = await makeUser(testDb.client);
    const org = await makeOrg(testDb.client, {
      ownerId: owner.id,
      ownerRole: "ADMIN",
    });
    const repo = await makeRepo(testDb.client, org.id, owner.id);
    return { owner, org, repo };
  }

  describe("strength resolution", () => {
    it("derives strength from the org binary-extension set, not a rule table", () => {
      expect(resolveClaimStrength(UASSET, NO_OVERRIDES)).toBe("EXCLUSIVE");
      expect(resolveClaimStrength(SOURCE, NO_OVERRIDES)).toBe("ADVISORY");
    });

    it("honours a per-org opt-out via -.ext", () => {
      expect(resolveClaimStrength(UASSET, "-.uasset")).toBe("ADVISORY");
    });

    it("honours a per-org opt-in via +.ext, so one list stays the source of truth", () => {
      expect(resolveClaimStrength("Data/thing.myformat", "+.myformat")).toBe(
        "EXCLUSIVE",
      );
    });

    it("forceExclusive overrides a mergeable path, for the refactor case", () => {
      expect(resolveClaimStrength(SOURCE, NO_OVERRIDES, true)).toBe(
        "EXCLUSIVE",
      );
    });
  });

  describe("domain resolution", () => {
    it("resolves a feature branch to its mainline root", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });

      const branch = await testDb.client.branch.findUniqueOrThrow({
        where: { repoId_name: { repoId: repo.id, name: "feature/a" } },
      });

      expect(
        await resolveDomainBranchName(testDb.client, repo.id, branch),
      ).toBe("main");
    });

    it("resolves a release branch to itself, isolating it from the mainline", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "release/1.0",
        type: "RELEASE",
        parentName: "main",
      });
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "hotfix/audio",
        type: "FEATURE",
        parentName: "release/1.0",
      });

      const hotfix = await testDb.client.branch.findUniqueOrThrow({
        where: { repoId_name: { repoId: repo.id, name: "hotfix/audio" } },
      });

      // A hotfix under a release branch belongs to the release domain, so it
      // does not freeze assets for anyone still building the next version.
      expect(
        await resolveDomainBranchName(testDb.client, repo.id, hotfix),
      ).toBe("release/1.0");
    });
  });

  describe("exclusive claims", () => {
    it("blocks a second workspace anywhere in the same domain", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });
      const wsA = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const wsB = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/a",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: wsA.id },
      });

      // A claim taken on a feature branch anchors at main, so it blocks main
      // itself. Downward-only inheritance would let someone edit the asset on
      // main and produce exactly the unmergeable conflict claims exist for.
      await expect(
        acquireClaim(testDb.client, {
          repoId: repo.id,
          fileId: file.id,
          filePath: UASSET,
          branchName: "main",
          orgBinaryExtensions: NO_OVERRIDES,
          actor: { userId: owner.id, workspaceId: wsB.id },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("does not block a different domain", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "release/1.0",
        type: "RELEASE",
        parentName: "main",
      });
      const wsA = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const wsB = await makeWorkspace(testDb.client, repo.id, org.id, owner.id, {
        domainBranchName: "release/1.0",
      });
      const file = await makeFile(testDb.client, repo.id, UASSET);

      await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: wsA.id },
      });

      // The release branch is its own domain: a stabilising release does not
      // freeze mainline development, which is the whole point of the split.
      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "release/1.0",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: wsB.id },
      });

      expect(claim.domainBranchName).toBe("release/1.0");
    });

    it("is idempotent for the workspace that already holds it", async () => {
      const { owner, org, repo } = await scaffold();
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const first = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const second = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      expect(second.claim.id).toBe(first.claim.id);
    });
  });

  describe("advisory claims", () => {
    it("stack freely: many holders, same path, same domain", async () => {
      const { owner, org, repo } = await scaffold();
      const wsA = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const wsB = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, SOURCE);

      // Advisory is Perforce `p4 edit`: recorded, displayed, never enforced.
      // Blocking two people from touching the same .cpp would be unusable.
      for (const ws of [wsA, wsB]) {
        const { claim } = await acquireClaim(testDb.client, {
          repoId: repo.id,
          fileId: file.id,
          filePath: SOURCE,
          branchName: "main",
          orgBinaryExtensions: NO_OVERRIDES,
          actor: { userId: owner.id, workspaceId: ws.id },
        });
        expect(claim.strength).toBe("ADVISORY");
      }

      const active = await testDb.client.fileClaim.count({
        where: { repoId: repo.id, fileId: file.id, releasedAt: null },
      });
      expect(active).toBe(2);

      // And none of them register as an exclusion.
      expect(
        await findActiveExclusiveClaim(testDb.client, repo.id, file.id, "main"),
      ).toBeNull();
    });
  });

  describe("freshness gate", () => {
    it("refuses an exclusive claim when the requester is behind", async () => {
      const { owner, org, repo } = await scaffold();
      await testDb.client.branch.updateMany({
        where: { repoId: repo.id, name: "main" },
        data: { headNumber: 12 },
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id, {
        syncedChangelistNumber: 7,
      });
      const file = await makeFile(testDb.client, repo.id, UASSET);

      // Refusing here costs a sync. Refusing at submit, which is what Perforce
      // does, costs the work, because a .uasset has no resolve.
      await expect(
        acquireClaim(testDb.client, {
          repoId: repo.id,
          fileId: file.id,
          filePath: UASSET,
          branchName: "main",
          orgBinaryExtensions: NO_OVERRIDES,
          actor: { userId: owner.id, workspaceId: ws.id },
          syncedChangelistNumber: 7,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("never refuses an advisory claim, however stale", async () => {
      const { owner, org, repo } = await scaffold();
      await testDb.client.branch.updateMany({
        where: { repoId: repo.id, name: "main" },
        data: { headNumber: 12 },
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id, {
        syncedChangelistNumber: 0,
      });
      const file = await makeFile(testDb.client, repo.id, SOURCE);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: SOURCE,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
        syncedChangelistNumber: 0,
      });

      expect(claim.strength).toBe("ADVISORY");
    });
  });

  describe("lifecycle", () => {
    it("releases on submit to the domain root, since the gap closes at once", async () => {
      const { owner, org, repo } = await scaffold();
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "main",
        targetIsDomainRoot: true,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const after = await testDb.client.fileClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after.releasedAt).not.toBeNull();
      expect(after.releasedByChangelistNumber).toBe(5);
    });

    it("parks as SUBMITTED on submit to a feature branch, still blocking", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      // Starting on main and then branching needs no explicit operation:
      // submitting to feature/a while holding the claim just advances it.
      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "feature/a",
        targetIsDomainRoot: false,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const after = await testDb.client.fileClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after.releasedAt).toBeNull();
      expect(after.state).toBe("SUBMITTED");
      expect(after.branchName).toBe("feature/a");
      expect(after.domainBranchName).toBe("main");
    });

    it("lets a collaborator on the holding branch reclaim, but nobody else", async () => {
      const { owner, org, repo } = await scaffold();
      const rae = await makeUser(testDb.client);
      await testDb.client.orgUser.create({
        data: { orgId: org.id, userId: rae.id, role: "MEMBER" },
      });
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/other",
        type: "FEATURE",
        parentName: "main",
      });
      const wsAna = await makeWorkspace(
        testDb.client,
        repo.id,
        org.id,
        owner.id,
      );
      const wsRae = await makeWorkspace(testDb.client, repo.id, org.id, rae.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/a",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: wsAna.id },
      });
      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "feature/a",
        targetIsDomainRoot: false,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: wsAna.id },
      });

      // Someone else on feature/a picks it up.
      const reclaimed = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/a",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: rae.id, workspaceId: wsRae.id },
      });

      expect(reclaimed.reclaimed).toBe(true);
      expect(reclaimed.claim.id).toBe(claim.id);
      expect(reclaimed.claim.state).toBe("OPEN");
      expect(reclaimed.claim.workspaceId).toBe(wsRae.id);

      // But a sibling feature branch in the same domain still cannot.
      await expect(
        acquireClaim(testDb.client, {
          repoId: repo.id,
          fileId: file.id,
          filePath: UASSET,
          branchName: "feature/other",
          orgBinaryExtensions: NO_OVERRIDES,
          actor: { userId: owner.id, workspaceId: wsAna.id },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("lets a stacked branch reclaim its parent's submitted work", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/base",
        type: "FEATURE",
        parentName: "main",
      });
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/stacked",
        type: "FEATURE",
        parentName: "feature/base",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/base",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });
      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "feature/base",
        targetIsDomainRoot: false,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      // Building a reviewable milestone on top of unreviewed work is the
      // point of stacking, and "holding branch or below" already allows it.
      const reclaimed = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/stacked",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      expect(reclaimed.reclaimed).toBe(true);
      expect(reclaimed.claim.branchName).toBe("feature/stacked");
    });
  });

  describe("merge settlement", () => {
    it("releases when the merge target is the domain root", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/a",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });
      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "feature/a",
        targetIsDomainRoot: false,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const result = await settleClaimsForMerge(testDb.client, {
        repoId: repo.id,
        incomingBranchName: "feature/a",
        targetBranchName: "main",
        mergeChangelistNumber: 9,
        paths: [UASSET],
        actor: { userId: owner.id },
      });

      expect(result).toEqual({ released: 1, advanced: 0 });
      const after = await testDb.client.fileClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after.releasedAt).not.toBeNull();
    });

    it("advances rather than releases when a stacked branch merges up", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/base",
        type: "FEATURE",
        parentName: "main",
      });
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/stacked",
        type: "FEATURE",
        parentName: "feature/base",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/stacked",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });
      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "feature/stacked",
        targetIsDomainRoot: false,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      // The work moved one rung up a stack but has not reached main, so the
      // claim must keep blocking. Re-anchoring onto the target also means the
      // release test never has to ask about branches that no longer exist.
      const result = await settleClaimsForMerge(testDb.client, {
        repoId: repo.id,
        incomingBranchName: "feature/stacked",
        targetBranchName: "feature/base",
        mergeChangelistNumber: 9,
        paths: [UASSET],
        actor: { userId: owner.id },
      });

      expect(result).toEqual({ released: 0, advanced: 1 });
      const after = await testDb.client.fileClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after.releasedAt).toBeNull();
      expect(after.branchName).toBe("feature/base");
      expect(after.state).toBe("SUBMITTED");
    });
  });

  describe("branch disposition", () => {
    it("releases claims when a branch is discarded, so paths do not stay locked", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/abandoned",
        type: "FEATURE",
        parentName: "main",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/abandoned",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const released = await releaseClaimsForBranch(
        testDb.client,
        repo.id,
        "feature/abandoned",
        { userId: owner.id },
      );

      expect(released).toBe(1);
      // The next claimant starts from the domain head, which does not contain
      // the discarded work, and the freshness gate agrees.
      expect(
        await findActiveExclusiveClaim(testDb.client, repo.id, file.id, "main"),
      ).toBeNull();
    });

    it("refuses to archive a branch that still holds claims", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/busy",
        type: "FEATURE",
        parentName: "main",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "feature/busy",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const caller = await makeAppCaller({ asUser: owner });

      // Silently releasing would strand committed binary work with no owner
      // and no signal, so the caller has to say discarding is intended.
      await expect(
        caller.branch.archiveBranch({
          repoId: repo.id,
          branchName: "feature/busy",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const archived = await caller.branch.archiveBranch({
        repoId: repo.id,
        branchName: "feature/busy",
        releaseOutstandingClaims: true,
        purgeable: true,
      });

      expect(archived.disposition).toBe("DISCARDED");
      expect(archived.purgeable).toBe(true);
      // Purgeability is about content GC and is deliberately orthogonal to
      // the release, which happens for both discard flavours.
      expect(
        await testDb.client.fileClaim.count({
          where: { repoId: repo.id, releasedAt: null },
        }),
      ).toBe(0);
    });
  });

  describe("cross-domain workspace switch", () => {
    async function claimOn(
      repoId: string,
      fileId: string,
      branchName: string,
      userId: string,
      workspaceId: string,
    ) {
      return acquireClaim(testDb.client, {
        repoId,
        fileId,
        filePath: UASSET,
        branchName,
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId, workspaceId },
      });
    }

    it("blocks a domain switch while files are still checked out", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "release/1.0",
        type: "RELEASE",
        parentName: "main",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);
      await claimOn(repo.id, file.id, "main", owner.id, ws.id);

      const caller = await makeAppCaller({ asUser: owner });

      // An OPEN claim is work still sitting in this working tree, which the
      // switch is about to replace.
      await expect(
        caller.workspace.setBranchState({
          workspaceId: ws.id,
          domainBranchName: "release/1.0",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("allows the switch once the work is submitted to a branch", async () => {
      const { owner, org, repo } = await scaffold();
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "feature/a",
        type: "FEATURE",
        parentName: "main",
      });
      await makeBranch(testDb.client, repo.id, owner.id, {
        name: "release/1.0",
        type: "RELEASE",
        parentName: "main",
      });
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);
      const { claim } = await claimOn(
        repo.id,
        file.id,
        "main",
        owner.id,
        ws.id,
      );

      await settleClaimAfterLanding(testDb.client, claim, {
        targetBranchName: "feature/a",
        targetIsDomainRoot: false,
        changelistNumber: 5,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const caller = await makeAppCaller({ asUser: owner });

      // A SUBMITTED claim has already reached the server and left the tree. It
      // stays anchored in the "main" domain and resolves when feature/a merges,
      // regardless of where this workspace points next. Counting it would make
      // submitting fail to clear the way, which is what the error tells people
      // to do, and would have left no escape once shelves were removed.
      await expect(
        caller.workspace.setBranchState({
          workspaceId: ws.id,
          domainBranchName: "release/1.0",
        }),
      ).resolves.toEqual({ ok: true });

      // The claim is untouched by the switch: still active, still anchored.
      const after = await testDb.client.fileClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after.releasedAt).toBeNull();
      expect(after.domainBranchName).toBe("main");
    });
  });

  describe("audit trail", () => {
    it("records every transition, so a forced release has a record", async () => {
      const { owner, org, repo } = await scaffold();
      const ws = await makeWorkspace(testDb.client, repo.id, org.id, owner.id);
      const file = await makeFile(testDb.client, repo.id, UASSET);

      const { claim } = await acquireClaim(testDb.client, {
        repoId: repo.id,
        fileId: file.id,
        filePath: UASSET,
        branchName: "main",
        orgBinaryExtensions: NO_OVERRIDES,
        actor: { userId: owner.id, workspaceId: ws.id },
      });

      const caller = await makeAppCaller({ asUser: owner });
      await caller.file.forceReleaseClaim({
        repoId: repo.id,
        claimId: claim.id,
      });

      const events = await testDb.client.fileClaimEvent.findMany({
        where: { claimId: claim.id },
        orderBy: { createdAt: "asc" },
      });

      expect(events.map((e) => e.type)).toEqual(["CLAIM", "FORCE_RELEASE"]);
      expect(events[1]?.userId).toBe(owner.id);
    });
  });
});
