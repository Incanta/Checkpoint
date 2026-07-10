import { InitApi } from "./api/index.js";
import { getInFlight, getLastActivityMs } from "./api/activity.js";
import { DaemonManager } from "./daemon-manager.js";
import { getUpdater } from "./updater.js";
import { ApiVersionChecker } from "./api-version-checker.js";

interface CliArgs {
  ephemeral: boolean;
  workspace: string | null;
  port: number;
  idleTimeoutMs: number;
  handshakePath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    ephemeral: false,
    workspace: null,
    port: 0,
    idleTimeoutMs: 45_000,
    handshakePath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i++;
      return value;
    };

    switch (arg) {
      case "--ephemeral":
        args.ephemeral = true;
        break;
      case "--workspace":
        args.workspace = takeValue();
        break;
      case "--port":
        args.port = parseInt(takeValue(), 10);
        break;
      case "--idle-timeout":
        args.idleTimeoutMs = parseInt(takeValue(), 10);
        break;
      case "--handshake":
        args.handshakePath = takeValue();
        break;
      default:
        // Ignore unknown args (e.g. the bundle path passed by the launcher).
        break;
    }
  }

  return args;
}

(async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const manager = DaemonManager.Get();

  const shutdown = async (): Promise<void> => {
    await manager.shutdown();
    process.exit(0);
  };

  if (args.ephemeral) {
    // --workspace is optional: auth/version-only invocations (login, accounts)
    // run a workspace-less ephemeral daemon.
    await manager.initEphemeral(args.workspace);
    await InitApi({
      ephemeral: true,
      port: args.port,
      handshakePath: args.handshakePath ?? undefined,
    });

    // Self-terminate once idle: no in-flight requests and no activity within
    // the idle window. This gives warm reuse for back-to-back CLI commands
    // while guaranteeing the process eventually exits.
    const checkIntervalMs = Math.max(
      1_000,
      Math.min(5_000, Math.floor(args.idleTimeoutMs / 3)),
    );
    const idleTimer = setInterval(() => {
      if (getInFlight() > 0) return;
      if (Date.now() - getLastActivityMs() >= args.idleTimeoutMs) {
        clearInterval(idleTimer);
        void shutdown();
      }
    }, checkIntervalMs);
    idleTimer.unref?.();

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  await manager.init();
  await InitApi();

  // Start the auto-update checker after the API is ready
  const updater = getUpdater();
  updater.start();

  // Start the API version compatibility checker
  const versionChecker = ApiVersionChecker.Get();
  versionChecker.start();

  // Clean up updater on shutdown
  const residentShutdown = async (): Promise<void> => {
    updater.stop();
    versionChecker.stop();
    await manager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void residentShutdown());
  process.on("SIGTERM", () => void residentShutdown());
})();
