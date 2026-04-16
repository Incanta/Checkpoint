#pragma once

#include <string>

namespace checkpoint {

constexpr const char* API_VERSION = "1.0.0";

struct VersionInfo {
  std::string currentVersion;
  std::string minimumVersion;
  std::string recommendedVersion;
};

// Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
inline int compareVersions(const std::string& a, const std::string& b) {
  auto parseSegments = [](const std::string& v) {
    std::vector<int> segments;
    std::string s = v;
    if (!s.empty() && s[0] == 'v') s = s.substr(1);
    size_t pos = 0;
    while (pos < s.size()) {
      size_t dot = s.find('.', pos);
      if (dot == std::string::npos) dot = s.size();
      segments.push_back(std::stoi(s.substr(pos, dot - pos)));
      pos = dot + 1;
    }
    return segments;
  };

  auto va = parseSegments(a);
  auto vb = parseSegments(b);

  size_t maxLen = std::max(va.size(), vb.size());
  for (size_t i = 0; i < maxLen; i++) {
    int na = (i < va.size()) ? va[i] : 0;
    int nb = (i < vb.size()) ? vb[i] : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

}  // namespace checkpoint
