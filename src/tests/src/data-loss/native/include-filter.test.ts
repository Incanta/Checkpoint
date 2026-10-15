/**
 * Red team, native layer: the Team Sync include rules the daemon hands the
 * native pull. Uses the real addon's matcher; needs no services, so it runs
 * wherever the native config does. See ../README.md.
 */
import { describe, expect, it } from "vitest";

import { filterPaths } from "@checkpointvcs/longtail-addon";

import { compileFilter } from "../../../../core/daemon/src/util/team-sync/filter.js";

describe("data loss (native): the native include filter", () => {
  it("includes everything the daemon's filter includes when a rule is typed in another case", () => {
    // On Windows and macOS "content/maps/" and "Content/Maps/" name the same
    // folder, so a rule typed either way looks right. The daemon's filter
    // (the ignore package, case-insensitive by default) includes the folder;
    // the native one compares bytes and skips it. The pull then never
    // downloads or records the folder's changes and still moves the
    // workspace's changelist past them, and the reconcile, which agrees the
    // folder is included, reports nothing. filter.ts relies on the native
    // filter only ever being broader than its own.
    const filter = compileFilter(null, {
      customIncludeRules: ["content/maps/"],
    });
    const paths = [
      "Content/Maps/arena.umap",
      "Content/Maps/Forest/forest.umap",
    ];

    expect(filter.nativeIncludeRules).not.toBeNull();
    expect(paths.map((p) => filter.matches(p))).toEqual([true, true]);
    expect(filterPaths(filter.nativeIncludeRules!, paths)).toEqual([
      true,
      true,
    ]);
  });
});
