#include "path-filter.h"

#include <cstring>

namespace Checkpoint {

namespace {

/**
 * Glob-match [pat, pat_end) against [text, text_end).
 *   "*"  any run of characters except "/"
 *   "**" any run of characters including "/"
 *   "?"  a single character except "/"
 * Patterns are short (a sync-category path), so plain backtracking is fine.
 */
bool GlobMatch(const char* pat,
               const char* pat_end,
               const char* text,
               const char* text_end) {
  while (pat < pat_end) {
    if (*pat == '*') {
      const bool double_star = (pat + 1 < pat_end) && pat[1] == '*';
      const char* rest = double_star ? pat + 2 : pat + 1;

      // Let "a/**/b" also match "a/b", which is how gitignore reads it.
      if (double_star && rest < pat_end && *rest == '/') {
        if (GlobMatch(rest + 1, pat_end, text, text_end)) {
          return true;
        }
      }

      for (const char* at = text;; ++at) {
        if (GlobMatch(rest, pat_end, at, text_end)) {
          return true;
        }
        if (at == text_end) {
          return false;
        }
        // A single "*" may not eat a separator.
        if (!double_star && *at == '/') {
          return false;
        }
      }
    }

    if (text == text_end) {
      return false;
    }
    if (*pat == '?') {
      if (*text == '/') {
        return false;
      }
    } else if (*pat != *text) {
      return false;
    }

    ++pat;
    ++text;
  }

  return text == text_end;
}

/** Offset just past the segment beginning at `start`. */
size_t SegmentEnd(const char* path, size_t len, size_t start) {
  size_t end = start;
  while (end < len && path[end] != '/') {
    ++end;
  }
  return end;
}

}  // namespace

PathFilter::PathFilter(const char* const* rules, uint32_t rule_count) {
  if (!rules) {
    return;
  }

  rules_.reserve(rule_count);

  for (uint32_t i = 0; i < rule_count; ++i) {
    if (!rules[i]) {
      continue;
    }

    std::string text = rules[i];
    for (char& c : text) {
      if (c == '\\') {
        c = '/';
      }
    }

    size_t begin = 0;
    while (begin < text.size() && text[begin] == '/') {
      ++begin;
    }
    size_t end = text.size();
    while (end > begin && text[end - 1] == '/') {
      --end;
    }
    text = text.substr(begin, end - begin);

    if (text.empty() || text[0] == '#') {
      continue;
    }

    Rule rule;
    // Anchored when the caller wrote a leading "/", or when a separator
    // survives normalization. A rule whose only separator was the trailing one
    // ("Engine/") stays unanchored, matching gitignore.
    rule.anchored = begin > 0 || text.find('/') != std::string::npos;
    rule.wildcard = text.find_first_of("*?") != std::string::npos;
    rule.text = std::move(text);
    rules_.push_back(std::move(rule));
  }
}

bool PathFilter::Includes(const char* path) const {
  if (rules_.empty()) {
    return true;
  }
  if (!path) {
    return false;
  }

  // Longtail marks directory entries with a trailing separator.
  size_t len = std::strlen(path);
  while (len > 0 && path[len - 1] == '/') {
    --len;
  }
  if (len == 0) {
    return true;  // the version root itself
  }

  for (const Rule& rule : rules_) {
    const size_t n = rule.text.size();

    if (!rule.wildcard) {
      if (rule.anchored) {
        // A literal anchored rule is a plain prefix test, which is what nearly
        // every sync-category path looks like.
        if (len >= n && std::strncmp(path, rule.text.c_str(), n) == 0 &&
            (len == n || path[n] == '/')) {
          return true;
        }
        continue;
      }

      // A literal unanchored rule matches when any single segment equals it;
      // the segments below a matched directory come along with it.
      bool matched = false;
      for (size_t start = 0; start <= len;) {
        const size_t seg_end = SegmentEnd(path, len, start);
        if (seg_end - start == n &&
            std::strncmp(path + start, rule.text.c_str(), n) == 0) {
          matched = true;
          break;
        }
        if (seg_end >= len) {
          break;
        }
        start = seg_end + 1;
      }
      if (matched) {
        return true;
      }
      continue;
    }

    // Wildcard rule: try the pattern against the path's segment ranges. Ending
    // a range at a segment boundary rather than only at the end of the path is
    // what lets a rule that matches a directory ("Content/*") pull in the files
    // beneath it. An anchored rule may only start at offset 0.
    const char* pat = rule.text.data();
    const char* pat_end = pat + n;

    for (size_t start = 0; start <= len;) {
      for (size_t stop = start + 1; stop <= len; ++stop) {
        if (stop != len && path[stop] != '/') {
          continue;
        }
        if (GlobMatch(pat, pat_end, path + start, path + stop)) {
          return true;
        }
      }
      if (rule.anchored) {
        break;
      }
      const size_t seg_end = SegmentEnd(path, len, start);
      if (seg_end >= len) {
        break;
      }
      start = seg_end + 1;
    }
  }

  return false;
}

}  // namespace Checkpoint
