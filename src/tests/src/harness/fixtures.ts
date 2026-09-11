// Factory functions for the DB shapes router code reads. Keep these tiny
// and explicit, so tests stay readable.

import type { PrismaClient } from "@prisma/client";
import { buildStateTreeBlocks } from "~/server/state-tree";

let counter = 0;
/** Process-unique id with a stable prefix. Exposed so premium fixtures can
 *  reuse the same counter instead of running a parallel one. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

// ── Users ────────────────────────────────────────────────────────

export interface MakeUserOpts {
  email?: string;
  name?: string | null;
  username?: string | null;
  checkpointAdmin?: boolean;
  emailVerified?: boolean;
}

export interface TestUser {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
}

export async function makeUser(
  db: PrismaClient,
  opts: MakeUserOpts = {},
): Promise<TestUser> {
  const email = opts.email ?? `user-${nextId("u")}@test.local`;
  const user = await db.user.create({
    data: {
      email,
      emailVerified: opts.emailVerified ?? true,
      name: opts.name ?? email.split("@")[0]!,
      username: opts.username ?? email.split("@")[0]!.replace(/[^a-z0-9]/gi, "_"),
      checkpointAdmin: opts.checkpointAdmin ?? false,
    },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    username: user.username ?? null,
  };
}

// ── Orgs ─────────────────────────────────────────────────────────

export interface MakeOrgOpts {
  name?: string;
  /** User to attach as the org's first member, with role. */
  ownerId?: string;
  ownerRole?: "MEMBER" | "BILLING" | "ADMIN";
  defaultRepoAccess?: "NONE" | "READ" | "WRITE" | "ADMIN";
  defaultCanCreateRepos?: boolean;
}

export interface TestOrg {
  id: string;
  name: string;
}

export async function makeOrg(
  db: PrismaClient,
  opts: MakeOrgOpts = {},
): Promise<TestOrg> {
  const org = await db.org.create({
    data: {
      name: opts.name ?? `org-${nextId("o")}`,
      defaultRepoAccess: opts.defaultRepoAccess ?? "READ",
      defaultCanCreateRepos: opts.defaultCanCreateRepos ?? true,
      ...(opts.ownerId && {
        users: {
          create: { userId: opts.ownerId, role: opts.ownerRole ?? "ADMIN" },
        },
      }),
    },
  });
  return { id: org.id, name: org.name };
}

// ── Repos ────────────────────────────────────────────────────────

export interface MakeRepoOpts {
  name?: string;
  public?: boolean;
  /** Create an initial changelist (#0) + `main` branch. Defaults to true. */
  withMainBranch?: boolean;
}

export interface TestRepo {
  id: string;
  name: string;
  orgId: string;
}

export async function makeRepo(
  db: PrismaClient,
  orgId: string,
  userId: string,
  opts: MakeRepoOpts = {},
): Promise<TestRepo> {
  const repo = await db.repo.create({
    data: {
      name: opts.name ?? `repo-${nextId("r")}`,
      orgId,
      public: opts.public ?? false,
    },
  });

  if (opts.withMainBranch !== false) {
    // CL 0 is the lineage root with an empty state tree (mirrors production).
    const rootHash = await buildStateTreeBlocks(db, repo.id, []);
    await db.changelist.create({
      data: {
        number: 0,
        message: "Repo Creation",
        versionIndex: "",
        stateRootHash: rootHash,
        repoId: repo.id,
        userId,
      },
    });
    await db.branch.create({
      data: {
        name: "main",
        repoId: repo.id,
        headNumber: 0,
        isDefault: true,
        type: "MAINLINE",
        // A mainline anchors its own claim domain.
        isClaimDomainRoot: true,
        domainBranchName: "main",
        createdById: userId,
      },
    });
  }

  return { id: repo.id, name: repo.name, orgId: repo.orgId };
}

// ── Workspaces ───────────────────────────────────────────────────

export interface MakeWorkspaceOpts {
  name?: string;
  /** The domain root the workspace materializes from. Defaults to "main". */
  domainBranchName?: string;
  /** Feature branches overlaid on the tree. Empty is the ordinary case. */
  activeBranches?: string[];
  syncedChangelistNumber?: number;
}

export async function makeWorkspace(
  db: PrismaClient,
  repoId: string,
  orgId: string,
  userId: string,
  opts: MakeWorkspaceOpts = {},
): Promise<{ id: string; name: string }> {
  const workspace = await db.workspace.create({
    data: {
      name: opts.name ?? `ws-${nextId("w")}`,
      repoId,
      orgId,
      userId,
      domainBranchName: opts.domainBranchName ?? "main",
      syncedChangelistNumber: opts.syncedChangelistNumber ?? null,
      activeBranches: opts.activeBranches
        ? {
            create: opts.activeBranches.map((branchName) => ({ branchName })),
          }
        : undefined,
    },
  });

  return { id: workspace.id, name: workspace.name };
}

// ── Files ────────────────────────────────────────────────────────

export async function makeFile(
  db: PrismaClient,
  repoId: string,
  path: string,
): Promise<{ id: string; path: string }> {
  const file = await db.file.create({ data: { repoId, path } });
  return { id: file.id, path: file.path };
}

// ── Branches ─────────────────────────────────────────────────────

export interface MakeBranchOpts {
  name?: string;
  parentName?: string;
  isDefault?: boolean;
  type?: "MAINLINE" | "RELEASE" | "FEATURE";
  headNumber?: number;
}

export async function makeBranch(
  db: PrismaClient,
  repoId: string,
  userId: string,
  opts: MakeBranchOpts = {},
): Promise<{ id: string; name: string }> {
  const name = opts.name ?? `branch-${nextId("b")}`;
  const type = opts.type ?? "FEATURE";
  const isClaimDomainRoot = type !== "FEATURE";

  // Mirror what branch.createBranch computes, so fixtures produce branches the
  // claim system can resolve a domain for. A feature branch inherits its
  // parent's domain (which for a stacked branch means walking past the parent),
  // and anything else anchors its own.
  let domainBranchName = name;
  if (!isClaimDomainRoot && opts.parentName) {
    const parent = await db.branch.findUnique({
      where: { repoId_name: { repoId, name: opts.parentName } },
      select: { name: true, domainBranchName: true, isClaimDomainRoot: true },
    });
    domainBranchName = parent?.isClaimDomainRoot
      ? parent.name
      : (parent?.domainBranchName ?? opts.parentName);
  }

  const branch = await db.branch.create({
    data: {
      name,
      repoId,
      headNumber: opts.headNumber ?? 0,
      isDefault: opts.isDefault ?? false,
      type,
      parentBranchName: opts.parentName ?? null,
      isClaimDomainRoot,
      domainBranchName,
      createdById: userId,
    },
  });
  return { id: branch.id, name: branch.name };
}

// ── Changelists ──────────────────────────────────────────────────

export interface MakeChangelistOpts {
  number?: number;
  message?: string;
  versionIndex?: string;
}

export async function makeChangelist(
  db: PrismaClient,
  repoId: string,
  userId: string,
  opts: MakeChangelistOpts = {},
): Promise<{ id: string; number: number }> {
  const cl = await db.changelist.create({
    data: {
      number: opts.number ?? 1,
      message: opts.message ?? "Test changelist",
      versionIndex: opts.versionIndex ?? "",
      repoId,
      userId,
    },
  });
  return { id: cl.id, number: cl.number };
}

// ── API tokens ───────────────────────────────────────────────────

export async function makeApiToken(
  db: PrismaClient,
  userId: string,
  opts: { name?: string; expiresAt?: Date | null; deviceCode?: string } = {},
): Promise<{ id: string; token: string }> {
  const token = `tok_${nextId("t")}`;
  const row = await db.apiToken.create({
    data: {
      name: opts.name ?? "test-token",
      token,
      userId,
      expiresAt: opts.expiresAt ?? null,
      deviceCode: opts.deviceCode ?? null,
    },
  });
  return { id: row.id, token: row.token };
}
