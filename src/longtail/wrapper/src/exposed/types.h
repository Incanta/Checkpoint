#pragma once

#include <cstdint>
#include <string>

namespace Checkpoint {

// What the submitter's copy of a file was based on. The server compares it
// with the file's state at the branch head and refuses the submit if they
// differ, so a submit cannot silently replace a change it never saw.
enum BaseState {
  // The caller did not say. The server does not check this path.
  BASE_UNSPECIFIED = 0,
  // The caller believes the file does not exist at the branch head.
  BASE_ABSENT = 1,
  // The caller's copy came from the changelist in BaseChangelist.
  BASE_CHANGELIST = 2,
};

struct Modification {
  bool IsDelete;
  const char* Path;
  const char* OldPath;
  int BaseState;
  long long BaseChangelist;
};

}  // namespace Checkpoint
