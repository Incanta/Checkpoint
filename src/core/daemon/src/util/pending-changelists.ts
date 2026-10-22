import path from "path";
import { promises as fs } from "fs";
import type {
  File,
  PendingChangelist,
  PendingChangelistState,
} from "../types/index.js";

/**
 * Store for the workspace's pending changelists (see PendingChangelistState).
 *
 * Kept in `.checkpoint/pending-changelists.json` beside the staged blobs
 * rather than in the workspace state: it is a client-side grouping of the
 * staged set, not part of what the workspace has pulled, and losing it only
 * returns files to their branch's default changelist.
 */

interface StoredState extends PendingChangelistState {
  /** The next id to hand out, so a deleted changelist's id is never reused. */
  nextId: number;
}

function storePath(workspaceLocalPath: string): string {
  return path.join(
    workspaceLocalPath,
    ".checkpoint",
    "pending-changelists.json",
  );
}

function emptyState(): StoredState {
  return {
    nextId: 1,
    changelists: [],
    assignments: {},
    defaultDescriptions: {},
  };
}

async function read(workspaceLocalPath: string): Promise<StoredState> {
  try {
    const raw = JSON.parse(
      await fs.readFile(storePath(workspaceLocalPath), "utf-8"),
    ) as Partial<StoredState>;
    return {
      nextId: raw.nextId ?? 1,
      changelists: raw.changelists ?? [],
      assignments: raw.assignments ?? {},
      defaultDescriptions: raw.defaultDescriptions ?? {},
    };
  } catch {
    // Missing or unreadable: no numbered changelists, everything in defaults.
    return emptyState();
  }
}

async function write(
  workspaceLocalPath: string,
  state: StoredState,
): Promise<void> {
  const file = storePath(workspaceLocalPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Serializes read-modify-write per workspace, so two quick calls (a drag and
 * a description edit) cannot each read the old file and drop the other's
 * change.
 */
const queues = new Map<string, Promise<unknown>>();

async function mutate<T>(
  workspaceLocalPath: string,
  fn: (state: StoredState) => T,
): Promise<T> {
  const prev = queues.get(workspaceLocalPath) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const state = await read(workspaceLocalPath);
      const result = fn(state);
      await write(workspaceLocalPath, state);
      return result;
    });
  queues.set(workspaceLocalPath, next);
  return next;
}

function toPublic(state: StoredState): PendingChangelistState {
  return {
    changelists: state.changelists,
    assignments: state.assignments,
    defaultDescriptions: state.defaultDescriptions,
  };
}

function find(state: StoredState, id: number): PendingChangelist {
  const changelist = state.changelists.find((c) => c.id === id);
  if (!changelist) {
    throw new Error(`Pending changelist ${id} does not exist.`);
  }
  return changelist;
}

export async function getPendingChangelists(
  workspaceLocalPath: string,
): Promise<PendingChangelistState> {
  return toPublic(await read(workspaceLocalPath));
}

export async function getPendingChangelist(
  workspaceLocalPath: string,
  id: number,
): Promise<PendingChangelist> {
  return find(await read(workspaceLocalPath), id);
}

export async function createPendingChangelist(
  workspaceLocalPath: string,
  branchName: string,
  description: string,
): Promise<PendingChangelist> {
  return mutate(workspaceLocalPath, (state) => {
    const changelist: PendingChangelist = {
      id: state.nextId++,
      description,
      branchName,
      createdAt: Date.now(),
    };
    state.changelists.push(changelist);
    return changelist;
  });
}

export async function updatePendingChangelistDescription(
  workspaceLocalPath: string,
  id: number,
  description: string,
): Promise<void> {
  await mutate(workspaceLocalPath, (state) => {
    find(state, id).description = description;
  });
}

/** Deletes a numbered changelist; its files return to the branch default. */
export async function deletePendingChangelist(
  workspaceLocalPath: string,
  id: number,
): Promise<void> {
  await mutate(workspaceLocalPath, (state) => {
    state.changelists = state.changelists.filter((c) => c.id !== id);
    for (const [p, assigned] of Object.entries(state.assignments)) {
      if (assigned === id) delete state.assignments[p];
    }
  });
}

export async function setDefaultChangelistDescription(
  workspaceLocalPath: string,
  branchName: string,
  description: string,
): Promise<void> {
  await mutate(workspaceLocalPath, (state) => {
    if (description === "") {
      delete state.defaultDescriptions[branchName];
    } else {
      state.defaultDescriptions[branchName] = description;
    }
  });
}

/**
 * Puts paths into a numbered changelist, or (with null) back into their
 * branch's default one.
 */
export async function assignToPendingChangelist(
  workspaceLocalPath: string,
  paths: string[],
  id: number | null,
): Promise<void> {
  if (paths.length === 0) return;
  await mutate(workspaceLocalPath, (state) => {
    if (id !== null) find(state, id);
    for (const p of paths) {
      if (id === null) delete state.assignments[p];
      else state.assignments[p] = id;
    }
  });
}

/**
 * Clears up after a submit: the submitted paths leave their changelist, and
 * the changelist itself is gone (a numbered one is deleted, a default one
 * loses its draft description), as Perforce does.
 */
export async function completePendingChangelistSubmit(
  workspaceLocalPath: string,
  submittedPaths: string[],
  submitted: { id: number } | { defaultOf: string },
): Promise<void> {
  await mutate(workspaceLocalPath, (state) => {
    for (const p of submittedPaths) delete state.assignments[p];
    if ("id" in submitted) {
      state.changelists = state.changelists.filter(
        (c) => c.id !== submitted.id,
      );
      for (const [p, assigned] of Object.entries(state.assignments)) {
        if (assigned === submitted.id) delete state.assignments[p];
      }
    } else {
      delete state.defaultDescriptions[submitted.defaultOf];
    }
  });
}

/** The branch a staged file is going to: its open claim's, else the domain. */
export function destinedBranch(file: File, domainBranchName: string): string {
  // The open claim is where the file is being worked on now; a submitted one
  // is where earlier work went (a parent in a stack).
  const claim = file.claims.find((c) => c.state === "OPEN") ?? file.claims[0];
  // No claim means nothing has pinned this file to a branch, so it belongs to
  // the domain root by default.
  return claim?.branchName ?? domainBranchName;
}

/**
 * Which numbered changelist a staged file is in, or null for its branch's
 * default. An assignment to a changelist on another branch does not count.
 */
export function changelistOf(
  file: File,
  state: PendingChangelistState,
  domainBranchName: string,
): number | null {
  const id = state.assignments[file.path];
  if (id === undefined) return null;
  const changelist = state.changelists.find((c) => c.id === id);
  if (!changelist) return null;
  return changelist.branchName === destinedBranch(file, domainBranchName)
    ? id
    : null;
}
