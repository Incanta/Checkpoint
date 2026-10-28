import type { TeamSyncConfigResult } from "./config-schema";

// Which linked repo pins a changelist moves, for the changelist browser's
// "update" badge and bisect's warning. Syncing across a pin change costs a
// linked sync and, for an engine, usually a rebuild. See
// docs/linked-repos-plan.md.

/** Where a link points: the linked repo's branch and changelist. */
export interface LinkPin {
  branch: string;
  changelist: number;
}

/** One link whose pin differs between two configs. */
export interface LinkPinChange {
  repo: string;
  /** Null when the link was added. */
  from: LinkPin | null;
  /** Null when the link was removed. */
  to: LinkPin | null;
}

type Links = { repo: string; branch: string; changelist: number }[];

/**
 * The links whose pin differs between two `linkedRepos` lists: added,
 * removed, or pointing at another branch or changelist. Repo names match
 * without case, as they do everywhere else. A link's `path` is not a pin, so
 * changing only that is not reported.
 */
export function diffLinkPins(
  before: Links | undefined,
  after: Links | undefined,
): LinkPinChange[] {
  const old = new Map((before ?? []).map((l) => [l.repo.toLowerCase(), l]));
  const changes: LinkPinChange[] = [];

  for (const link of after ?? []) {
    const key = link.repo.toLowerCase();
    const prev = old.get(key);
    old.delete(key);
    if (prev?.branch === link.branch && prev.changelist === link.changelist) {
      continue;
    }
    changes.push({
      repo: link.repo,
      from: prev ? { branch: prev.branch, changelist: prev.changelist } : null,
      to: { branch: link.branch, changelist: link.changelist },
    });
  }
  for (const prev of old.values()) {
    changes.push({
      repo: prev.repo,
      from: { branch: prev.branch, changelist: prev.changelist },
      to: null,
    });
  }
  return changes;
}

/** Reads the repo config as of a changelist. */
export type ReadConfigAt = (
  changelistNumber: number,
) => Promise<TeamSyncConfigResult>;

/**
 * The links in a config result, or "unknown" when the file exists but is
 * invalid. An invalid config says nothing about pins, so comparing against it
 * would report every link as added or removed.
 */
function linksOf(result: TeamSyncConfigResult): Links | "unknown" {
  if (result.errors !== null) return "unknown";
  return result.config?.linkedRepos ?? [];
}

/**
 * The pin changes between the configs at two changelists, or null when
 * either config is invalid or cannot be read.
 */
export async function comparePinsBetween(
  fromChangelist: number,
  toChangelist: number,
  readConfig: ReadConfigAt,
): Promise<LinkPinChange[] | null> {
  try {
    const [from, to] = await Promise.all([
      readConfig(fromChangelist),
      readConfig(toChangelist),
    ]);
    const before = linksOf(from);
    const after = linksOf(to);
    if (before === "unknown" || after === "unknown") return null;
    return diffLinkPins(before, after);
  } catch {
    return null;
  }
}

/**
 * Pin changes per changelist, for changelists that touched the config file.
 * Each is compared with its parent, so a merge counts what it brought in. A
 * changelist with no parent is compared with no config. Changelists whose
 * comparison is unknown, or that changed no pin, are left out.
 */
export async function pinChangesForChangelists(
  touched: { number: number; parentNumber: number | null }[],
  readConfig: ReadConfigAt,
): Promise<Map<number, LinkPinChange[]>> {
  const result = new Map<number, LinkPinChange[]>();
  for (const cl of touched) {
    const changes =
      cl.parentNumber === null
        ? await linksAt(cl.number, readConfig).then((links) =>
            links === null ? null : diffLinkPins([], links),
          )
        : await comparePinsBetween(cl.parentNumber, cl.number, readConfig);
    if (changes && changes.length > 0) result.set(cl.number, changes);
  }
  return result;
}

async function linksAt(
  changelistNumber: number,
  readConfig: ReadConfigAt,
): Promise<Links | null> {
  try {
    const links = linksOf(await readConfig(changelistNumber));
    return links === "unknown" ? null : links;
  } catch {
    return null;
  }
}
