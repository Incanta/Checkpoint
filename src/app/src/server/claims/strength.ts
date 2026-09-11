import { ClaimStrength } from "@prisma/client";

import {
  resolveBinaryExtensions,
  isBinaryFile,
} from "~/server/binary-extensions";

/**
 * Resolves how strongly a claim on `path` binds.
 *
 * There is deliberately no separate rule table. The org's binary-extensions set
 * already answers exactly this question in exactly the right place: it resolves
 * config defaults with per-org "+.ext" / "-.ext" overrides, it is already cached
 * and consumed on both the server and the daemon, and `auto-merge.ts` already
 * uses it to decide whether a file can be merged at all. A second list of glob
 * patterns would duplicate it, need its own settings UI, and give the two ways
 * to disagree about whether a .uasset is mergeable.
 *
 * The default is opt-out rather than opt-in for a reason: a binary that
 * resolved to ADVISORY would get no exclusivity and no freshness gate, so two
 * people take it in parallel and the second one's work is unrecoverable at
 * merge. A format nobody has thought about yet should land on the safe side.
 */
export function resolveClaimStrength(
  path: string,
  orgBinaryExtensions: string,
  forceExclusive = false,
): ClaimStrength {
  if (forceExclusive) {
    return ClaimStrength.EXCLUSIVE;
  }

  return isBinaryFile(path, resolveBinaryExtensions(orgBinaryExtensions))
    ? ClaimStrength.EXCLUSIVE
    : ClaimStrength.ADVISORY;
}

/** Batch form, so a submit resolves the whole modification list in one pass. */
export function resolveClaimStrengths(
  paths: string[],
  orgBinaryExtensions: string,
): Map<string, ClaimStrength> {
  const extensions = resolveBinaryExtensions(orgBinaryExtensions);

  return new Map(
    paths.map((path) => [
      path,
      isBinaryFile(path, extensions)
        ? ClaimStrength.EXCLUSIVE
        : ClaimStrength.ADVISORY,
    ]),
  );
}
