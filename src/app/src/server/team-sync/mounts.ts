// Nested linked repos (a `linkedRepos` entry with a `path`) mount another
// repo's workspace at a folder inside this repo's. That folder belongs to the
// child, so this repo must not track files there: a link onto files this repo
// has is rejected when the config is read, and a submit that adds files under
// a mount path is refused. Folder names compare without case, since Windows
// and macOS would put both spellings in one folder. See
// docs/linked-repos-plan.md.

type Links = { repo: string; path?: string }[] | undefined;

const normalize = (p: string): string =>
  p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/** The mount paths in a config's links, normalized. */
export function mountPathsOf(linkedRepos: Links): string[] {
  return (linkedRepos ?? [])
    .map((l) => (l.path === undefined ? "" : normalize(l.path)))
    .filter((p) => p.length > 0);
}

/** The mount path `path` is at or under, or null. */
export function mountContaining(
  path: string,
  mounts: readonly string[],
): string | null {
  const p = normalize(path).toLowerCase();
  for (const mount of mounts) {
    const m = mount.toLowerCase();
    if (p === m || p.startsWith(`${m}/`)) return mount;
  }
  return null;
}

/** Lists a directory of the repo's tree ("" for the root), or null. */
export type ListTreeDir = (dir: string) => Promise<{
  files: { name: string }[];
  dirs: string[];
} | null>;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * A file the tree has at or under `mount` (any spelling), or null when there
 * is none. Reads only the directories on the way down and, when it finds the
 * folder, the first path to a file inside it.
 */
export async function trackedUnderMount(
  mount: string,
  listDir: ListTreeDir,
): Promise<string | null> {
  const segments = normalize(mount).split("/");
  let frontier = [""];
  for (const segment of segments) {
    const want = segment.toLowerCase();
    const next: string[] = [];
    for (const dir of frontier) {
      const listing = await listDir(dir);
      if (!listing) continue;
      // A file standing where the folder would go collides too.
      const file = listing.files.find((f) => f.name.toLowerCase() === want);
      if (file) return join(dir, file.name);
      for (const d of listing.dirs) {
        if (d.toLowerCase() === want) next.push(join(dir, d));
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  for (const dir of frontier) {
    const example = await firstFile(dir, listDir);
    if (example) return example;
  }
  return null;
}

async function firstFile(
  dir: string,
  listDir: ListTreeDir,
): Promise<string | null> {
  const listing = await listDir(dir);
  if (!listing) return null;
  const file = listing.files[0];
  if (file) return join(dir, file.name);
  for (const d of listing.dirs) {
    const found = await firstFile(join(dir, d), listDir);
    if (found) return found;
  }
  return null;
}

/**
 * Config errors for nested links mounted onto files the repo tracks, in the
 * same `path: message` form as schema errors. Empty when there are none.
 */
export async function mountCollisionErrors(
  linkedRepos: Links,
  listDir: ListTreeDir,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [index, link] of (linkedRepos ?? []).entries()) {
    if (link.path === undefined) continue;
    const example = await trackedUnderMount(link.path, listDir);
    if (example) {
      errors.push(
        `linkedRepos.${index}.path: "${link.path}" is where ${link.repo} would be mounted, but this repo tracks files there (${example}). Move or delete them first.`,
      );
    }
  }
  return errors;
}

/**
 * Why a submit may not add these paths, or null: files added or changed
 * under a nested linked repo's mount path belong in that repo. Deleting them
 * is fine (it clears the way).
 */
export function mountSubmitProblem(
  modifications: { path: string; delete: boolean }[],
  mounts: readonly string[],
): string | null {
  if (mounts.length === 0) return null;
  const blocked = modifications
    .filter((m) => !m.delete)
    .map((m) => ({ path: m.path, mount: mountContaining(m.path, mounts) }))
    .filter((m): m is { path: string; mount: string } => m.mount !== null);
  if (blocked.length === 0) return null;
  const shown = blocked.slice(0, 5).map((b) => b.path);
  const more = blocked.length > shown.length ? ` and ${blocked.length - shown.length} more` : "";
  const folders = [...new Set(blocked.map((b) => b.mount))].join(", ");
  return `Cannot submit ${shown.join(", ")}${more}: ${folders} belongs to a linked repo mounted there (see teamsync.yaml). Submit these files to that repo instead.`;
}
