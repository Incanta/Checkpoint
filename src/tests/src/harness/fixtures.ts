// Factory functions for the DB shapes router code reads. Keep these tiny
// and explicit — tests should be readable.

import type { PrismaClient } from "@prisma/client";

let counter = 0;
function nextId(prefix: string): string {
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
    await db.changelist.create({
      data: {
        number: 0,
        message: "Repo Creation",
        versionIndex: "",
        stateTree: {},
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
        createdById: userId,
      },
    });
  }

  return { id: repo.id, name: repo.name, orgId: repo.orgId };
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
  const branch = await db.branch.create({
    data: {
      name: opts.name ?? `branch-${nextId("b")}`,
      repoId,
      headNumber: opts.headNumber ?? 0,
      isDefault: opts.isDefault ?? false,
      type: opts.type ?? "FEATURE",
      parentBranchName: opts.parentName ?? null,
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
      stateTree: {},
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
