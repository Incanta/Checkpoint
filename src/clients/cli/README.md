# Checkpoint CLI

A cross-platform C++ command-line client for interacting with the Checkpoint daemon service.

## Commands

The table below covers the most common commands. The complete, user-facing reference (including `init`, `login`, `switch`, `merge`, `clean`, `artifact upload`, `update`, `mcp`, and headless sign-in) is on the docs site: [CLI](https://checkpointvcs.com/docs/clients/cli), source in [`website/docusaurus/docs/clients/cli.md`](../../../website/docusaurus/docs/clients/cli.md).

| Command                          | Description                   | Example                             |
| -------------------------------- | ----------------------------- | ----------------------------------- |
| `chk status`                     | Show pending changes          | `chk status`                        |
| `chk add <file...>`              | Stage files for submission    | `chk add src/main.cpp`              |
| `chk add -b <branch> <file...>`  | Stage into a feature branch   | `chk add -b feature/hud hud.uasset` |
| `chk add -c <id> <file...>`      | Stage into a pending changelist | `chk add -c 3 hud.uasset`         |
| `chk move -b <branch> <file...>` | Restage into another branch   | `chk move -b feature/hud hud.uasset`|
| `chk move -c <id> <file...>`     | Restage into a pending changelist | `chk move -c 3 hud.uasset`      |
| `chk changelist new [-m <msg>] [-b <branch>]` | Create an empty pending changelist and print its id (alias `chk cl`) | `chk cl new -m "HUD pass"` |
| `chk changelist list`            | List pending changelists with file counts (also the default with no action) | `chk cl list` |
| `chk changelist edit <id\|default> -m <msg> [-b <branch>]` | Set a changelist's description; `-b` picks whose default changelist | `chk cl edit default -m "WIP" -b feature/hud` |
| `chk changelist delete <id>`     | Delete a pending changelist; its files stay staged in their branch's default | `chk cl delete 3` |
| `chk restore --staged <file...>` | Unstage files                 | `chk restore --staged src/main.cpp` |
| `chk restore <file...>`          | Revert files to the version you last synced | `chk restore src/main.cpp`          |
| `chk chmod (+x\|-x) <file...>`   | Executable or not in the next submit (works on Windows, which has no executable bit) | `chk chmod +x tools/build.sh` |
| `chk submit -m <message>`        | Submit staged files           | `chk submit -m "Fix bug"`           |
| `chk submit -b <branch> -m <msg>`| Submit one branch's bucket    | `chk submit -b feature/hud -m "WIP"`|
| `chk submit -c <id> [-m <msg>]`  | Submit a pending changelist   | `chk submit -c 3`                   |
| `chk pull`                       | Sync changes from remote      | `chk pull`                          |
| `chk log`                        | Show version history          | `chk log`                           |
| `chk branch`                     | List branches                 | `chk branch`                        |
| `chk checkout <file>`            | Check out a controlled file   | `chk checkout src/main.cpp`         |
| `chk checkout -x <file>`         | Check out with an exclusive claim, even on a mergeable file | `chk checkout -x notes.md` |
| `chk revert <file...>`           | Revert files to the version you last synced | `chk revert src/main.cpp`           |
| `chk revert -a [file...]`        | Revert files identical to head version (all pending changes when no files are given) | `chk revert -a`                     |
| `chk bug-report`                 | Collect a redacted log bundle (zip) for a bug report and print its path | `chk bug-report` |
| `chk redact <file> [-o out]`     | Write a redacted copy of a log file, e.g. `docker compose logs` output | `chk redact logs.txt` |
| `chk diff <file>`                | Show diff for a file          | `chk diff src/main.cpp`             |

### Pending changelists

Like Perforce, staged files can be grouped into numbered pending changelists that submit separately. Each changelist belongs to one branch (the domain root or an active overlay) and submits there. Every branch also has an unnumbered default changelist, which holds any staged file not in a numbered one. The grouping is local to the workspace (`.checkpoint/pending-changelists.json`); losing it only returns files to their branch's default changelist.

`chk status` lists each branch's default changelist, then each numbered one (including empty ones). `chk add` and `chk move -b` put files in a branch's default changelist; `-c <id>` puts them in a numbered one instead. `chk restore --staged` takes a file out of its changelist along with unstaging it.

`chk submit` submits one changelist: the domain root's default, the default of `-b <branch>`, or numbered changelist `-c <id>`. Without `-m`, the changelist's description is the message. A submitted numbered changelist is deleted, and a default changelist's description is cleared.

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
# Non-interactive login with an API token (mint one in the web app under Settings, Devices & Tokens):
chk login --token "$CHK_TOKEN" --endpoint https://checkpoint.example.com

# ...or skip login entirely and pass the token via the environment:
export CHECKPOINT_API_TOKEN="..."
export CHECKPOINT_ENDPOINT="https://checkpoint.example.com"

chk status   # spawns an ephemeral daemon on demand
```

Environment variables:

- `CHECKPOINT_DAEMONLESS=1`: force daemonless mode (same as the `--no-daemon` flag).
- `CHECKPOINT_API_TOKEN` / `CHECKPOINT_ENDPOINT`: non-interactive auth with no `auth.json`.
- `CHECKPOINT_DAEMON_BIN`: override the directory containing `checkpoint-daemon` and `daemon-bundle.cjs` (normally discovered relative to the CLI binary).

## Platform Support

- Windows x64 (MinGW / MSVC)
- Linux x64 (GCC / Clang)
- macOS x64 and arm64 (Clang)

## Dependencies

- [argparse](https://github.com/p-ranav/argparse): CLI argument parsing (header-only, bundled)
- [libcurl](https://curl.se/libcurl/): HTTP client
- [nlohmann/json](https://github.com/nlohmann/json): JSON parsing
