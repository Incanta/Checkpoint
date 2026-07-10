#pragma once

/**
 * Daemonless / headless support for the Checkpoint CLI.
 *
 * The CLI is a thin tRPC-over-HTTP client; all VCS logic lives in the Node
 * daemon. In headless environments (CI, Linux servers) there is no resident
 * daemon. This module lets the CLI transparently spawn the bundled daemon in
 * an ephemeral, workspace-scoped mode, reuse it for back-to-back commands, and
 * let it self-terminate on idle.
 *
 * Resolution order for a command's daemon endpoint:
 *   1. Resident daemon (unless --no-daemon / CHECKPOINT_DAEMONLESS forces off).
 *   2. A warm ephemeral daemon recorded in the workspace's handshake file.
 *   3. A freshly spawned ephemeral daemon.
 */

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "daemon_client.hpp"
#include "workspace.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

namespace checkpoint {
namespace fs = std::filesystem;

// ─── Mode selection ──────────────────────────────────────────────

inline bool& forceDaemonlessFlag() {
  static bool value = false;
  return value;
}

/** Set from the top-level `--no-daemon` flag. */
inline void setForceDaemonless(bool value) { forceDaemonlessFlag() = value; }

/** True when the CLI must not use (or start) a resident daemon. */
inline bool isDaemonlessForced() {
  if (forceDaemonlessFlag()) return true;
  const char* env = std::getenv("CHECKPOINT_DAEMONLESS");
  if (env == nullptr) return false;
  std::string v(env);
  return !v.empty() && v != "0" && v != "false";
}

// ─── Home / state dirs ───────────────────────────────────────────

inline fs::path getHomeDir() {
#ifdef _WIN32
  const char* userProfile = std::getenv("USERPROFILE");
  return userProfile ? fs::path(userProfile) : fs::path();
#else
  const char* home = std::getenv("HOME");
  return home ? fs::path(home) : fs::path();
#endif
}

inline fs::path globalStateDir() { return getHomeDir() / ".checkpoint"; }

// ─── Executable directory discovery ──────────────────────────────

inline fs::path getExecutableDir() {
#ifdef _WIN32
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (n == 0) return {};
  return fs::path(std::wstring(buf, n)).parent_path();
#elif defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string buf(size, '\0');
  if (_NSGetExecutablePath(buf.data(), &size) != 0) return {};
  std::error_code ec;
  fs::path resolved = fs::weakly_canonical(fs::path(buf.c_str()), ec);
  return (ec ? fs::path(buf.c_str()) : resolved).parent_path();
#else
  std::error_code ec;
  fs::path p = fs::read_symlink("/proc/self/exe", ec);
  if (ec) return {};
  return p.parent_path();
#endif
}

// ─── Bundled daemon discovery ────────────────────────────────────

struct DaemonPaths {
  fs::path nodeBin;
  fs::path bundle;
};

/**
 * Locates the bundled daemon runtime (`checkpoint-daemon` + `daemon-bundle.cjs`)
 * relative to the CLI executable, mirroring the installer/tarball layout.
 * Override the search with CHECKPOINT_DAEMON_BIN (path to the daemon dir).
 */
inline DaemonPaths findDaemonPaths() {
  std::vector<fs::path> dirs;

  if (const char* override = std::getenv("CHECKPOINT_DAEMON_BIN")) {
    dirs.emplace_back(override);
  }

  fs::path exeDir = getExecutableDir();
  if (!exeDir.empty()) {
    dirs.push_back(exeDir / "resources" / "daemon");         // tarball layout
    dirs.push_back(exeDir / ".." / "resources" / "daemon");  // app-bundle layout
    dirs.push_back(exeDir);                                   // co-located
  }

#ifndef _WIN32
  // Absolute fallbacks for system package installs (deb/rpm), where the CLI
  // lands in /usr/bin and the bundled daemon under an FHS lib dir.
  dirs.emplace_back("/usr/lib/checkpoint/resources/daemon");
  dirs.emplace_back("/usr/local/lib/checkpoint/resources/daemon");
  dirs.emplace_back("/opt/Checkpoint/resources/daemon");
#endif

#ifdef _WIN32
  const std::string nodeName = "checkpoint-daemon.exe";
#else
  const std::string nodeName = "checkpoint-daemon";
#endif

  for (const auto& dir : dirs) {
    fs::path node = dir / nodeName;
    fs::path bundle = dir / "daemon-bundle.cjs";
    std::error_code ec;
    if (fs::exists(node, ec) && fs::exists(bundle, ec)) {
      return {node, bundle};
    }
  }

  throw std::runtime_error(
      "Could not locate the bundled Checkpoint daemon runtime. "
      "Set CHECKPOINT_DAEMON_BIN to the directory containing "
      "'checkpoint-daemon' and 'daemon-bundle.cjs'.");
}

// ─── Health probe & process liveness ─────────────────────────────

inline std::string baseUrlForPort(int port) {
  return "http://127.0.0.1:" + std::to_string(port);
}

/** Cheap liveness check: does a daemon answer version.check at this URL? */
inline bool probeDaemon(const std::string& baseUrl) {
  try {
    DaemonClient client(baseUrl);
    auto res = client.query("version.check");
    return res.is_object();
  } catch (...) {
    return false;
  }
}

inline bool isProcessAlive(long pid) {
  if (pid <= 0) return false;
#ifdef _WIN32
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
  if (h == nullptr) return false;
  DWORD r = WaitForSingleObject(h, 0);
  CloseHandle(h);
  return r == WAIT_TIMEOUT;
#else
  return kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM;
#endif
}

// ─── Handshake file ──────────────────────────────────────────────

struct EphemeralInfo {
  long pid = 0;
  int port = 0;
};

inline bool readHandshake(const fs::path& path, EphemeralInfo& out) {
  try {
    std::ifstream f(path);
    if (!f) return false;
    nlohmann::json j;
    f >> j;
    if (!j.value("ready", false)) return false;
    out.pid = j.value("pid", 0L);
    out.port = j.value("port", 0);
    return out.port > 0;
  } catch (...) {
    return false;
  }
}

// ─── Cross-invocation lock ───────────────────────────────────────

/**
 * Serializes the reuse-or-spawn critical section across concurrent CLI
 * invocations in the same workspace so two ephemeral daemons never race to
 * initialize the same state store.
 */
class ScopedFileLock {
 public:
  explicit ScopedFileLock(const fs::path& path) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
#ifndef _WIN32
    fd_ = ::open(path.c_str(), O_CREAT | O_RDWR, 0644);
    if (fd_ >= 0) {
      ::flock(fd_, LOCK_EX);
    }
#else
    (void)path;
#endif
  }

  ~ScopedFileLock() {
#ifndef _WIN32
    if (fd_ >= 0) {
      ::flock(fd_, LOCK_UN);
      ::close(fd_);
    }
#endif
  }

  ScopedFileLock(const ScopedFileLock&) = delete;
  ScopedFileLock& operator=(const ScopedFileLock&) = delete;

 private:
#ifndef _WIN32
  int fd_ = -1;
#endif
};

// ─── Spawn a detached ephemeral daemon ───────────────────────────

inline void spawnEphemeralDaemon(const DaemonPaths& paths,
                                 const fs::path& workspaceRoot,
                                 const fs::path& handshakePath,
                                 const fs::path& logPath) {
  std::vector<std::string> args = {
      paths.nodeBin.string(),
      paths.bundle.string(),
      "--ephemeral",
      "--port",
      "0",
      "--handshake",
      handshakePath.string(),
  };
  if (!workspaceRoot.empty()) {
    args.push_back("--workspace");
    args.push_back(workspaceRoot.string());
  }

#ifdef _WIN32
  // Build a command line with each argument quoted.
  std::string cmdline;
  for (size_t i = 0; i < args.size(); ++i) {
    if (i) cmdline += ' ';
    cmdline += '"' + args[i] + '"';
  }
  std::wstring wcmd(cmdline.begin(), cmdline.end());

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(
      nullptr, wcmd.data(), nullptr, nullptr, FALSE,
      DETACHED_PROCESS | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
  if (!ok) {
    throw std::runtime_error("Failed to start the Checkpoint daemon process.");
  }
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
#else
  // Double-fork so the daemon is fully detached (new session, reparented to
  // init) and never becomes a zombie of the short-lived CLI.
  pid_t pid = fork();
  if (pid < 0) {
    throw std::runtime_error("fork() failed while starting the daemon.");
  }
  if (pid == 0) {
    setsid();

    pid_t pid2 = fork();
    if (pid2 < 0) _exit(127);
    if (pid2 > 0) _exit(0);  // intermediate parent exits immediately

    // Grandchild: this becomes the daemon. Detach stdio.
    int logFd = ::open(logPath.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (logFd >= 0) {
      dup2(logFd, STDOUT_FILENO);
      dup2(logFd, STDERR_FILENO);
      if (logFd > STDERR_FILENO) ::close(logFd);
    }
    int nullFd = ::open("/dev/null", O_RDONLY);
    if (nullFd >= 0) {
      dup2(nullFd, STDIN_FILENO);
      if (nullFd > STDERR_FILENO) ::close(nullFd);
    }

    std::vector<char*> argv;
    argv.reserve(args.size() + 1);
    for (auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
    argv.push_back(nullptr);

    execv(paths.nodeBin.c_str(), argv.data());
    _exit(127);  // exec failed
  }

  // CLI (original parent): reap the short-lived intermediate child.
  int status = 0;
  waitpid(pid, &status, 0);
#endif
}

// ─── Resolver ────────────────────────────────────────────────────

/**
 * Resolves the base URL of a daemon to use for the given workspace. Pass an
 * empty path for auth/version-only commands that need no workspace.
 *
 * Prefers a resident daemon, then a warm ephemeral one, then spawns a fresh
 * ephemeral daemon and waits for its handshake.
 */
inline std::string resolveDaemonBaseUrl(const fs::path& workspaceRoot) {
  // 1. Prefer a resident daemon unless explicitly disabled.
  if (!isDaemonlessForced()) {
    std::string url = baseUrlForPort(getDaemonPort());
    if (probeDaemon(url)) return url;
  }

  // 2/3. Ephemeral path.
  fs::path stateDir =
      workspaceRoot.empty() ? globalStateDir() : (workspaceRoot / ".checkpoint");
  const char* handshakeName =
      workspaceRoot.empty() ? "ephemeral-global.json" : "ephemeral.json";
  fs::path handshake = stateDir / handshakeName;
  fs::path lockPath = stateDir / "ephemeral.lock";
  fs::path logPath = stateDir / "ephemeral.log";

  ScopedFileLock lock(lockPath);

  // 2. Reuse a warm ephemeral daemon if one is alive and answering.
  EphemeralInfo info;
  if (readHandshake(handshake, info) && isProcessAlive(info.pid)) {
    std::string url = baseUrlForPort(info.port);
    if (probeDaemon(url)) return url;
  }

  // 3. Spawn a fresh one. Clear any stale handshake first so we detect the new.
  std::error_code ec;
  fs::remove(handshake, ec);

  DaemonPaths paths = findDaemonPaths();
  spawnEphemeralDaemon(paths, workspaceRoot, handshake, logPath);

  // Poll for readiness (Node + native addon cold start can take a few seconds).
  auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(30);
  while (std::chrono::steady_clock::now() < deadline) {
    if (readHandshake(handshake, info) && info.port > 0) {
      std::string url = baseUrlForPort(info.port);
      if (probeDaemon(url)) return url;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  throw std::runtime_error(
      "Timed out starting the Checkpoint daemon. See " + logPath.string() +
      " for details.");
}

/** Resolve a daemon for auth/version-only commands (no workspace needed). */
inline std::string resolveGlobalDaemonBaseUrl() {
  return resolveDaemonBaseUrl(fs::path{});
}

/**
 * Returns the resident daemon's base URL if one is reachable, else empty.
 * Never spawns. Used by best-effort, non-essential checks (version gate,
 * update banner) so they stay silent in headless mode.
 */
inline std::string tryResidentBaseUrl() {
  if (isDaemonlessForced()) return "";
  std::string url = baseUrlForPort(getDaemonPort());
  return probeDaemon(url) ? url : "";
}

}  // namespace checkpoint
