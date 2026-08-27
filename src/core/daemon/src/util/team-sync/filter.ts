import { createHash } from "crypto";
import ignore, { type Ignore } from "ignore";
import type { TeamSyncConfig, TeamSyncCategory } from "@checkpointvcs/common";

import type { WorkspaceTeamSyncSettings } from "../util.js";

export interface CompiledSyncFilter {
  /** True when no categories/rules are defined: every path is in-filter. */
  isNoOp: boolean;
  /** Stable hash of the resolved filter, for refilter detection. */
  hash: string;
  /** Whether a repo-relative forward-slash path is included by the filter. */
  matches(relPath: string): boolean;
  /**
   * The include rules in the form the native pull's matcher accepts
   * (`includePaths` on longtail-addon's pullAsync), or null when they can't be
   * handed over safely. Passing these lets longtail skip excluded assets during
   * the pull instead of downloading them for `reconcileSyncFilter` to delete.
   *
   * Null means "pull everything, filter afterwards" and is returned when the
   * filter is a no-op or when any rule uses syntax the native matcher does not
   * implement. Only the include rules are passed: exclude rules are left to the
   * post-pull reconcile, so the native filter can only ever be broader than
   * this one. That direction is the safe one, since over-including just wastes
   * a download the reconcile then discards, whereas under-including would leave
   * a file the workspace needs missing from disk.
   */
  nativeIncludeRules: string[] | null;
}

/**
 * Syntax the native matcher (src/longtail/wrapper/src/util/path-filter.h) does
 * not implement: "!" negation, "[...]" character classes, and "\" escapes. A
 * rule using any of them disables native filtering for the whole sync rather
 * than risking a disagreement with `ignore`.
 */
const NATIVE_UNSUPPORTED = /[!\[\]\\]/;

/**
 * Resolve which sync categories are enabled: start from each category's
 * default, apply the workspace overrides, then transitively enable the
 * dependencies (`requires`) of every enabled category.
 */
export function resolveEnabledCategories(
  categories: TeamSyncCategory[],
  overrides: Record<string, boolean> | undefined,
): Set<string> {
  const byId = new Map(categories.map((cat) => [cat.id, cat]));
  const enabled = new Set<string>();

  for (const cat of categories) {
    const override = overrides?.[cat.id];
    if (override ?? cat.enabledByDefault) {
      enabled.add(cat.id);
    }
  }

  // Transitively pull in required categories.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...enabled]) {
      const cat = byId.get(id);
      if (!cat) continue;
      for (const req of cat.requires) {
        if (byId.has(req) && !enabled.has(req)) {
          enabled.add(req);
          changed = true;
        }
      }
    }
  }

  return enabled;
}

/**
 * Compile a workspace's effective sync filter from the repo config's
 * categories plus the workspace's overrides and custom include/exclude rules.
 *
 * Semantics: a path is in-filter when it matches an enabled category path or a
 * custom include rule, and is not matched by a custom exclude rule. When no
 * categories and no custom include rules exist, the filter is a no-op (every
 * path is included), matching a workspace that has never narrowed its sync.
 */
export function compileFilter(
  config: TeamSyncConfig | null,
  settings: WorkspaceTeamSyncSettings | undefined,
): CompiledSyncFilter {
  const categories = config?.syncCategories ?? [];
  const enabledIds = resolveEnabledCategories(
    categories,
    settings?.categoryOverrides,
  );

  const includeRules: string[] = [];
  const enabledSorted = [...enabledIds].sort();
  for (const id of enabledSorted) {
    const cat = categories.find((c) => c.id === id);
    if (cat) includeRules.push(...cat.paths);
  }
  const customInclude = settings?.customIncludeRules ?? [];
  const customExclude = settings?.customExcludeRules ?? [];
  includeRules.push(...customInclude);

  const isNoOp = includeRules.length === 0;

  const hash = createHash("sha1")
    .update(
      JSON.stringify({
        enabledCategoryIds: enabledSorted,
        includeRules,
        excludeRules: customExclude,
      }),
    )
    .digest("hex");

  if (isNoOp) {
    return {
      isNoOp: true,
      hash,
      matches: () => true,
      nativeIncludeRules: null,
    };
  }

  const includeMatcher: Ignore = ignore().add(includeRules);
  const excludeMatcher: Ignore | null =
    customExclude.length > 0 ? ignore().add(customExclude) : null;

  const nativeIncludeRules = includeRules.some((rule) =>
    NATIVE_UNSUPPORTED.test(rule),
  )
    ? null
    : includeRules;

  return {
    isNoOp: false,
    hash,
    nativeIncludeRules,
    matches(relPath: string): boolean {
      // `ignore` throws on absolute or empty paths; guard defensively.
      if (!relPath) return false;
      const normalized = relPath.replace(/\\/g, "/").replace(/^\//, "");
      if (!normalized) return false;
      if (excludeMatcher?.ignores(normalized)) return false;
      return includeMatcher.ignores(normalized);
    },
  };
}
