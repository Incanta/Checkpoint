import ignore, { type Ignore } from "ignore";
import path from "path";
import { promises as fs, type Dirent } from "fs";

import {
  matchesPattern,
  normalizeRelativePath,
  ownerOf,
} from "../file-status.js";
import { isDirectoryLink } from "./links.js";
import { unsupportedNameReason } from "./workspace-path.js";

/**
 * Which files an artifact upload collects. Artifacts are build outputs, which
 * `.chkignore` almost always ignores, so these rules replace it rather than
 * add to it: patterns use the same syntax as `.chkignore`.
 */
export interface ArtifactRules {
  include: string[];
  exclude: string[];
}

/** The repo config's artifact channel, as far as uploads need it. */
interface ArtifactChannel {
  type: string;
  include?: string[];
  exclude?: string[];
}

/** The rules for `type` in the repo config, or null when it has none. */
export function artifactRulesFor(
  channels: readonly ArtifactChannel[] | undefined,
  type: string,
): ArtifactRules | null {
  const channel = channels?.find((c) => c.type === type);
  if (!channel) return null;
  return { include: channel.include ?? [], exclude: channel.exclude ?? [] };
}

/**
 * The folders a walk for these include patterns has to start from: the
 * literal folders before each pattern's last segment or first wildcard. A
 * pattern that can match at any depth (no slash before its end, like
 * `*.dll` or `Binaries/`) means the whole workspace.
 */
export function walkRoots(include: readonly string[]): string[] {
  const roots: string[] = [];
  for (const raw of include) {
    if (raw.startsWith("!") || raw.startsWith("#")) continue;
    const anchored = raw.startsWith("/");
    const segments = raw
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .split("/");
    if (!anchored && segments.length === 1) return [""];
    const literal: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      if (/[*?[\]\\]/.test(segment)) break;
      literal.push(segment);
    }
    roots.push(literal.join("/"));
  }
  // Keep only the outermost: a root inside another is walked by it.
  const sorted = [...new Set(roots)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of sorted) {
    if (root === "") return [""];
    const inside = kept.some((k) =>
      `${root.toLowerCase()}/`.startsWith(`${k.toLowerCase()}/`),
    );
    if (!inside) kept.push(root);
  }
  return kept;
}

/**
 * Calls `onFile` for every file below `start` (repo-relative, "" for the
 * root), skipping `.checkpoint`, nested workspaces, links to folders, names
 * the server can't store, and anything `exclude` matches.
 */
async function walkFiles(
  root: string,
  start: string,
  owned: readonly string[],
  exclude: Ignore,
  onFile: (relative: string) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(root, start), { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    const relative = start ? `${start}/${entry.name}` : entry.name;
    if (relative === ".checkpoint" || relative.startsWith(".checkpoint/")) {
      continue;
    }
    if (unsupportedNameReason(entry.name)) continue;
    if (ownerOf(owned, relative) !== null) continue;
    if (entry.isDirectory()) {
      if (!matchesPattern(exclude, relative, true)) subdirs.push(relative);
      continue;
    }
    if (
      entry.isSymbolicLink() &&
      (await isDirectoryLink(path.join(root, relative)))
    ) {
      continue;
    }
    if (matchesPattern(exclude, relative)) continue;
    onFile(relative);
  }
  await Promise.all(
    subdirs.map((dir) => walkFiles(root, dir, owned, exclude, onFile)),
  );
}

/**
 * Every file in the workspace the rules select: matching an include pattern
 * and no exclude pattern. `.chkignore` does not apply. Sorted.
 */
export async function collectArtifactFiles(
  root: string,
  rules: ArtifactRules,
  owned: readonly string[] = [],
): Promise<string[]> {
  const include = ignore().add(rules.include);
  const exclude = ignore().add(rules.exclude);
  const found = new Set<string>();
  for (const start of walkRoots(rules.include)) {
    await walkFiles(root, start, owned, exclude, (relative) => {
      if (matchesPattern(include, relative)) found.add(relative);
    });
  }
  return [...found].sort();
}

/**
 * The files to upload for paths named on the command line: a file as is,
 * and a folder as every file in it except what `exclude` matches.
 * `.chkignore` does not apply. Sorted.
 */
export async function expandArtifactPaths(
  root: string,
  paths: readonly string[],
  exclude: readonly string[],
  owned: readonly string[] = [],
): Promise<string[]> {
  const excludes = ignore().add([...exclude]);
  const found = new Set<string>();
  for (const raw of paths) {
    const relative = normalizeRelativePath(raw.replace(/\\/g, "/")).replace(
      /\/+$/,
      "",
    );
    if (relative && ownerOf(owned, relative) !== null) {
      throw new Error(
        `${relative} is in another workspace nested here; upload its artifacts from that workspace`,
      );
    }
    let stat;
    try {
      stat = await fs.stat(path.join(root, relative));
    } catch {
      throw new Error(`${raw} does not exist`);
    }
    if (stat.isDirectory()) {
      await walkFiles(root, relative, owned, excludes, (file) =>
        found.add(file),
      );
    } else {
      found.add(relative);
    }
  }
  return [...found].sort();
}
