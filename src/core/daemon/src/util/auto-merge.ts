import { diff3Merge } from "node-diff3";
import { isBinaryFile } from "./read-file.js";

/** Git-style conflict markers used in merged output. */
export const CONFLICT_MARKER_START = "<<<<<<<";
export const CONFLICT_MARKER_SEP = "=======";
export const CONFLICT_MARKER_END = ">>>>>>>";

/** Labels used in conflict markers. */
export const LABEL_CURRENT = "CURRENT";
export const LABEL_INCOMING = "INCOMING";

/**
 * Result of a 3-way auto-merge operation.
 */
export interface AutoMergeResult {
  /** Whether the merge completed without conflicts. */
  clean: boolean;
  /** The merged file content (may contain conflict markers if not clean). */
  content: string;
}

/**
 * Perform a 3-way merge on text file content.
 *
 * @param base     - The common ancestor version (from the CL the local state was based on)
 * @param current  - The local (working copy) version on disk
 * @param incoming - The remote (server) version being pulled
 * @returns The merge result with the merged content and whether it was clean
 */
export function autoMergeText(
  base: string,
  current: string,
  incoming: string,
): AutoMergeResult {
  const regions = diff3Merge<string>(current, base, incoming, {
    stringSeparator: /\r?\n/,
  });

  let hasConflict = false;
  const lines: string[] = [];

  for (const region of regions) {
    if (region.ok) {
      lines.push(...region.ok);
    } else if (region.conflict) {
      hasConflict = true;
      lines.push(`${CONFLICT_MARKER_START} ${LABEL_CURRENT}`);
      lines.push(...region.conflict.a);
      lines.push(CONFLICT_MARKER_SEP);
      lines.push(...region.conflict.b);
      lines.push(`${CONFLICT_MARKER_END} ${LABEL_INCOMING}`);
    }
  }

  return {
    clean: !hasConflict,
    content: lines.join("\n"),
  };
}

/**
 * Regex that matches any git-style conflict marker start line.
 * Used to detect whether a file has unresolved merge conflicts.
 */
const CONFLICT_MARKER_REGEX = /^<{7} /m;

/**
 * Check whether a file's text content contains git-style conflict markers.
 *
 * @param content - The file content to check
 * @returns true if the content contains conflict markers
 */
export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_REGEX.test(content);
}

/**
 * Whether a file path is eligible for auto-merge (i.e. it is a text file).
 */
export function canAutoMerge(filePath: string): boolean {
  return !isBinaryFile(filePath);
}
