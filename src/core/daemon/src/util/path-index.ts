/**
 * Directory structure of a workspace's tracked files, so questions like
 * "which tracked files are under this directory" and "which file has this id"
 * cost what the answer costs instead of a scan over every tracked path.
 *
 * The change-detection loops used to answer them by iterating every tracked
 * path once per dirty path, which made a refresh O(dirty x tracked).
 */
export class PathIndex {
  /** dir ("" is the root) -> names of tracked files directly in it. */
  private readonly files = new Map<string, Set<string>>();
  /** dir -> names of child directories holding tracked files. */
  private readonly children = new Map<string, Set<string>>();
  /** Directories that are ancestors of a marked-for-add path. */
  private readonly markedDirs = new Set<string>();
  private readonly ids = new Map<string, string>();

  public constructor(
    tracked: Record<string, { fileId: string }>,
    markedForAdd: Iterable<string> = [],
  ) {
    this.children.set("", new Set());
    for (const [rawPath, entry] of Object.entries(tracked)) {
      const filePath = rawPath.replace(/^\//, "");
      const slash = filePath.lastIndexOf("/");
      const dir = slash < 0 ? "" : filePath.slice(0, slash);
      const name = slash < 0 ? filePath : filePath.slice(slash + 1);
      this.addDir(dir);
      let names = this.files.get(dir);
      if (!names) {
        names = new Set();
        this.files.set(dir, names);
      }
      names.add(name);
      if (!this.ids.has(entry.fileId)) this.ids.set(entry.fileId, filePath);
    }
    for (const rawPath of markedForAdd) {
      const parts = rawPath.replace(/^\//, "").split("/");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        this.markedDirs.add(current);
      }
    }
  }

  private addDir(dir: string): void {
    // Collect the missing ancestors, then link them top-down so each parent
    // exists before its child is added to it.
    const missing: string[] = [];
    let current = dir;
    while (current && !this.children.has(current)) {
      missing.push(current);
      const slash = current.lastIndexOf("/");
      current = slash < 0 ? "" : current.slice(0, slash);
    }
    for (let i = missing.length - 1; i >= 0; i--) {
      const child = missing[i]!;
      const slash = child.lastIndexOf("/");
      const parent = slash < 0 ? "" : child.slice(0, slash);
      this.children.set(child, new Set());
      this.children.get(parent)!.add(child.slice(slash + 1));
    }
  }

  /**
   * Whether `dir` holds tracked files (directly or below) or the ancestor of
   * a path marked for add. The root always counts.
   */
  public hasTrackedDir(dir: string): boolean {
    const normalized = dir.replace(/^\//, "").replace(/\/$/, "");
    return this.children.has(normalized) || this.markedDirs.has(normalized);
  }

  /** Tracked files at any depth under `dir`, as workspace-relative paths. */
  public filesUnder(dir: string): string[] {
    const root = dir.replace(/^\//, "").replace(/\/$/, "");
    if (!this.children.has(root)) return [];
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const name of this.files.get(current) ?? []) {
        out.push(current ? `${current}/${name}` : name);
      }
      for (const child of this.children.get(current) ?? []) {
        stack.push(current ? `${current}/${child}` : child);
      }
    }
    return out;
  }

  /** The tracked path recorded with `fileId`, if any. */
  public pathOf(fileId: string): string | undefined {
    return this.ids.get(fileId);
  }
}

/**
 * The entries of `paths` that are `dir` itself or lie under any directory in
 * `dirs`. Walks each path's ancestors, so it costs O(paths x depth) instead
 * of O(paths x dirs).
 */
export function pathsUnderAny(
  paths: Iterable<string>,
  dirs: Set<string>,
): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let current = p.replace(/\/$/, "");
    while (true) {
      const slash = current.lastIndexOf("/");
      if (slash < 0) break;
      current = current.slice(0, slash);
      if (dirs.has(current) || dirs.has(`${current}/`)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}
