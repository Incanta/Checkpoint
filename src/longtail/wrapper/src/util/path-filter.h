#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace Checkpoint {

/**
 * An ordered set of gitignore-style include rules, matched against
 * repo-relative forward-slash asset paths.
 *
 * Used by the pull to skip assets the caller does not want materialized, so
 * excluded files are never downloaded rather than downloaded and then deleted.
 * The rules come from the daemon's compiled sync filter (see
 * src/core/daemon/src/util/game-sync/filter.ts), which builds them from the
 * repo's Game Sync sync categories plus the workspace's custom include rules.
 *
 * Supported syntax, chosen to agree with the `ignore` npm package the daemon
 * matches with:
 *   - A leading "/" anchors the rule to the repo root.
 *   - A rule that contains a "/" other than a trailing one is likewise
 *     anchored; one that does not ("Engine/", "*.uasset") matches at any depth.
 *   - A trailing "/" is stripped; a rule that matches a directory pulls in that
 *     directory's whole subtree, as gitignore does.
 *   - "*" matches within a single path segment, "**" matches across segments,
 *     and "?" matches one non-separator character.
 *
 * NOT supported: "!" negation and "[...]" character classes. The daemon is
 * responsible for withholding rules that use them (it falls back to filtering
 * after the pull in that case), so this class never sees them. The consequence
 * of a disagreement is deliberately one-sided: matching too broadly only costs
 * a download the daemon then discards, whereas matching too narrowly would skip
 * a file the workspace needs.
 */
class PathFilter {
 public:
  /** A filter with no rules includes everything. */
  PathFilter() = default;

  PathFilter(const char* const* rules, uint32_t rule_count);

  /** True when no rules were given, i.e. nothing is filtered out. */
  bool IsNoOp() const { return rules_.empty(); }

  /**
   * Whether an asset path is included. `path` is repo-relative with forward
   * slashes; a trailing slash (which Longtail uses to mark directory entries)
   * is ignored.
   */
  bool Includes(const char* path) const;

 private:
  struct Rule {
    /** Normalized rule text: no leading or trailing separators. */
    std::string text;
    /** Anchored to the repo root rather than matching at any depth. */
    bool anchored = false;
    /** Contains "*" or "?", so it needs the glob matcher rather than a compare. */
    bool wildcard = false;
  };

  std::vector<Rule> rules_;
};

}  // namespace Checkpoint
