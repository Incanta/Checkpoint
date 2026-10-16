/**
 * The Team Sync include rules the daemon hands the native pull must never
 * match less there than the daemon's own filter does: a file the native pull
 * skips is never downloaded, and the reconcile, which counts it as included,
 * never brings it back (DL-26). Runs both matchers over the same rules and
 * paths with the real addon (the source-built one in CI). Needs no services.
 */
import { describe, expect, it } from "vitest";

import { filterPaths } from "@checkpointvcs/longtail-addon";

import { compileFilter } from "../../../core/daemon/src/util/team-sync/filter.js";

const PATHS = [
  "Content/Maps/arena.umap",
  "Content/Maps/Forest/forest.umap",
  "content/maps/lower.umap",
  "Content/Mapsish/not-a-map.umap",
  "Source/Game/Main.cpp",
  "Source/Game/main.CPP",
  "Plugins/MyPlugin/Content/Maps/plugin.umap",
  "Docs/Résumé/cv.txt",
  "Docs/rÉsumÉ/cv.txt",
];

describe("the native include filter agrees with the daemon's", () => {
  it.each([
    ["a rule typed in another case", ["content/maps/"]],
    ["an anchored rule in another case", ["/CONTENT/MAPS"]],
    ["an unanchored rule", ["maps/"]],
    ["a single-star rule", ["Source/*/*.cpp"]],
    ["a double-star rule", ["**/maps/**"]],
    ["a question-mark rule", ["Content/Map?/"]],
    ["several rules", ["Source/", "content/MAPS/"]],
  ])("for %s", (_what, rules) => {
    const filter = compileFilter(null, { customIncludeRules: rules });
    expect(filter.nativeIncludeRules).not.toBeNull();
    const daemon = PATHS.map((p) => filter.matches(p));
    const native = filterPaths(filter.nativeIncludeRules!, PATHS);
    // Never narrower natively: what the daemon includes, the native pull must
    // too. (Broader only costs a download the reconcile discards.)
    PATHS.forEach((p, i) => {
      if (daemon[i]) expect(native[i], p).toBe(true);
    });
  });

  it("withholds a rule with non-ASCII letters from the native filter", () => {
    // The native filter folds ASCII case only, the daemon's folds more; such
    // a rule could match less natively, so the pull fetches everything and
    // the reconcile filters instead.
    const filter = compileFilter(null, {
      customIncludeRules: ["docs/résumé/"],
    });
    expect(filter.nativeIncludeRules).toBeNull();
    expect(filter.matches("Docs/RÉSUMÉ/cv.txt")).toBe(true);
  });
});
