#include "asset-path.h"

#include <cstring>

namespace Checkpoint {

namespace {

bool NamesCheckpointDir(std::string segment) {
  const size_t colon = segment.find(':');
  if (colon != std::string::npos) {
    segment.resize(colon);
  }
  while (!segment.empty() &&
         (segment.back() == '.' || segment.back() == ' ')) {
    segment.pop_back();
  }
  for (char& c : segment) {
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  if (segment == ".checkpoint") {
    return true;
  }
  // 8.3 short name: "checkp~" followed by digits.
  const char* prefix = "checkp~";
  const size_t n = std::strlen(prefix);
  if (segment.size() > n && segment.compare(0, n, prefix) == 0) {
    for (size_t i = n; i < segment.size(); ++i) {
      if (segment[i] < '0' || segment[i] > '9') {
        return false;
      }
    }
    return true;
  }
  return false;
}

}  // namespace

std::string UnsafeAssetPathReason(const char* path) {
  if (!path) {
    return "no path";
  }
  std::string p(path);
  while (!p.empty() && p.back() == '/') {
    p.pop_back();
  }
  if (p.empty()) {
    return "an empty path";
  }
  if (p[0] == '/' || p[0] == '\\') {
    return "a leading separator";
  }
  if (p.size() >= 2 && p[1] == ':' &&
      ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z'))) {
    return "a drive letter";
  }
  for (char c : p) {
    const unsigned char u = static_cast<unsigned char>(c);
    if (u < 0x20 || u == 0x7f) {
      return "a control character";
    }
#ifdef _WIN32
    if (c == ':') {
      return "a \":\", which Windows reads as a stream separator";
    }
#endif
  }

  size_t start = 0;
  bool first = true;
  while (true) {
    size_t end = p.find_first_of("/\\", start);
    const std::string segment =
        p.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (segment.empty()) {
      return "an empty segment";
    }
    if (segment == "." || segment == "..") {
      return "a \"" + segment + "\" segment";
    }
    if (first && NamesCheckpointDir(segment)) {
      return "the workspace's .checkpoint directory";
    }
    first = false;
    if (end == std::string::npos) {
      break;
    }
    start = end + 1;
  }
  return "";
}

}  // namespace Checkpoint
