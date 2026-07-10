# Checkpoint CLI

A cross-platform C++ command-line client for interacting with the Checkpoint daemon service.

## Commands

| Command                          | Description                   | Example                             |
| -------------------------------- | ----------------------------- | ----------------------------------- |
| `chk status`                     | Show pending changes          | `chk status`                        |
| `chk add <file...>`              | Stage files for submission    | `chk add src/main.cpp`              |
| `chk restore --staged <file...>` | Unstage files                 | `chk restore --staged src/main.cpp` |
| `chk restore <file...>`          | Revert files to head          | `chk restore src/main.cpp`          |
| `chk submit -m <message>`        | Submit staged files           | `chk submit -m "Fix bug"`           |
| `chk pull`                       | Sync changes from remote      | `chk pull`                          |
| `chk log`                        | Show version history          | `chk log`                           |
| `chk branch`                     | List branches                 | `chk branch`                        |
| `chk checkout <file>`            | Check out a controlled file   | `chk checkout src/main.cpp`         |
| `chk checkout --lock <file>`     | Check out with exclusive lock | `chk checkout --lock model.fbx`     |
| `chk revert <file...>`           | Revert files to head version  | `chk revert src/main.cpp`           |
| `chk diff <file>`                | Show diff for a file          | `chk diff src/main.cpp`             |

## Build

### Requirements

- CMake >= 3.15
- C++17 compiler (MSVC, GCC, Clang)
- [vcpkg](https://github.com/microsoft/vcpkg) with packages: `curl`, `nlohmann-json`
- libcurl (via vcpkg or system package)

### Build Steps (Windows with vcpkg + MinGW)

```bash
cd src/clients/cli
mkdir build && cd build
cmake .. -G "MinGW Makefiles" \
  -DCMAKE_TOOLCHAIN_FILE=/c/vcpkg/scripts/buildsystems/vcpkg.cmake \
  -DVCPKG_TARGET_TRIPLET=x64-mingw-static
cmake --build .
```

### Build Steps (Linux / macOS)

```bash
cd src/clients/cli
mkdir build && cd build
cmake .. -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build .
```

Or with system-installed curl and nlohmann-json:

```bash
cmake ..
cmake --build .
```

## How It Works

The CLI communicates with the Checkpoint daemon via its tRPC HTTP API (default: `http://127.0.0.1:13010`). It auto-detects the workspace by walking up from the current directory to find a `.checkpoint/` directory.

### Workspace Detection

Run any command from within a Checkpoint workspace directory. The CLI walks up the directory tree looking for `.checkpoint/workspace.json` which contains the workspace ID, daemon ID, and branch info.

### Daemon Configuration

The daemon port is read from `~/.checkpoint/daemon.json` (key: `daemonPort`, default: `13010`).

## Headless / Daemonless Mode

For servers and CI, the CLI can run with no pre-installed daemon. When no resident
daemon is reachable, it spawns the bundled daemon (shipped alongside the CLI under
`resources/daemon/`) in an ephemeral, workspace-scoped mode, runs the command, and lets
it self-terminate after a short idle period. Back-to-back commands reuse the warm daemon.

Install one of the `checkpoint-cli-*` release artifacts (portable `.tar.gz`/`.zip`, or a
Linux `.deb`/`.rpm`), put `chk` on your `PATH`, then:

```bash
# Non-interactive login with an API token (mint one in Settings > Devices):
chk login --token "$CHK_TOKEN" --endpoint https://app.checkpointvcs.com

# ...or skip login entirely and pass the token via the environment:
export CHECKPOINT_API_TOKEN="..."
export CHECKPOINT_ENDPOINT="https://app.checkpointvcs.com"

chk status   # spawns an ephemeral daemon on demand
```

Environment variables:

- `CHECKPOINT_DAEMONLESS=1` — force daemonless mode (same as the `--no-daemon` flag).
- `CHECKPOINT_API_TOKEN` / `CHECKPOINT_ENDPOINT` — non-interactive auth with no `auth.json`.
- `CHECKPOINT_DAEMON_BIN` — override the directory containing `checkpoint-daemon` and
  `daemon-bundle.cjs` (normally discovered relative to the CLI binary).

## Platform Support

- Windows x64 (MinGW / MSVC)
- Linux x64 (GCC / Clang)
- macOS x64 and arm64 (Clang)

## Dependencies

- [argparse](https://github.com/p-ranav/argparse) — CLI argument parsing (header-only, bundled)
- [libcurl](https://curl.se/libcurl/) — HTTP client
- [nlohmann/json](https://github.com/nlohmann/json) — JSON parsing
