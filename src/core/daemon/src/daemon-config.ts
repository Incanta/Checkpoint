import { existsSync, promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import type { Workspace } from "./types/index.js";

export interface DaemonConfigType {
  daemonPort: number;
  /** Opt-in MCP (Model Context Protocol) server exposing the daemon API */
  mcp: {
    enabled: boolean;
    port: number;
  };
  workspaces: Workspace[];
  /**
   * Kept for compatibility with existing daemon.json files. Workspace state
   * is always a WAL-mode SQLite DB now; a workspace still on state.json is
   * imported on first open, whatever this says.
   */
  stateBackend: "json" | "sqlite";
  updates: {
    /**
     * Delivery stream the auto-updater follows. "release" tracks published
     * releases; "nightly" tracks the rolling prerelease built off main. See
     * src/core/daemon/src/updater.ts.
     */
    channel: "release" | "nightly";
  };
  logging: {
    level: string;
    prettify: {
      enabled: boolean;
      include: string[];
      colorize: boolean;
      colorizeObjects: boolean;
      crlf: boolean;
      levelFirst: boolean;
      messageFormat: string | false;
      translateTime: string;
      ignore: string[];
      hideObject: boolean;
      singleLine: boolean;
    };
    logFile: {
      /** Ignored: the daemon always writes its log file (see logging.ts). */
      enabled: boolean;
      level: string;
      path: string;
      maxArchivedFiles: number;
      /** The log is archived and a new one started past this size. 0 = never. */
      maxFileSizeMB: number;
    };
  };
  longtail: {
    /*
     * Chunk and block sizes, hashing, and compression: used only with servers
     * that do not send a repo's own (storage.getToken `longtail`), which
     * every current server does. The rest are this machine's to tune.
     */
    targetChunkSize: number;
    targetBlockSize: number;
    maxChunksPerBlock: number;
    minBlockUsagePercent: number;
    hashingAlgo: string;
    compressionAlgo: string;
    enableMmapIndexing: boolean;
    enableMmapBlockStore: boolean;
    enableBlockCache: boolean;
    logLevel: string;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copies into `target` every key of `defaults` it lacks, recursing into
 * nested objects. Values already present (arrays included) are kept as is.
 * Returns whether anything was added.
 */
export function fillMissing(
  target: Record<string, unknown>,
  defaults: object,
): boolean {
  let added = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in target) || target[key] === undefined) {
      target[key] = structuredClone(value);
      added = true;
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      added = fillMissing(target[key], value) || added;
    }
  }
  return added;
}

export class DaemonConfig {
  private static instance: DaemonConfig | null = null;
  private static configPath = path.join(
    homedir(),
    ".checkpoint",
    "daemon.json",
  );

  private static loaded = false;

  public vars: DaemonConfigType;

  private constructor() {
    this.vars = {
      // defaults go here
      daemonPort: 13010,
      mcp: {
        enabled: false,
        port: 13011,
      },
      workspaces: [],
      stateBackend: "sqlite",
      updates: {
        channel: "release",
      },
      logging: {
        level: "info",
        prettify: {
          enabled: true,
          include: [],
          colorize: true,
          colorizeObjects: true,
          crlf: false,
          levelFirst: false,
          messageFormat: false,
          translateTime: "SYS:standard",
          ignore: [],
          hideObject: false,
          singleLine: false,
        },
        logFile: {
          enabled: false,
          level: "info",
          path: "logs/daemon.log",
          maxArchivedFiles: 10,
          maxFileSizeMB: 20,
        },
      },
      longtail: {
        targetChunkSize: 32768,
        targetBlockSize: 8388608,
        maxChunksPerBlock: 1024,
        minBlockUsagePercent: 80,
        hashingAlgo: "blake3",
        compressionAlgo: "zstd",
        enableMmapIndexing: false,
        enableMmapBlockStore: false,
        enableBlockCache: false,
        logLevel: "off",
      },
    };
  }

  public static Ensure(): DaemonConfig {
    if (!DaemonConfig.instance) {
      DaemonConfig.instance = new DaemonConfig();
    }

    return DaemonConfig.instance;
  }

  public static async Get(): Promise<DaemonConfigType> {
    if (!DaemonConfig.loaded) {
      await DaemonConfig.Load();
    }

    return DaemonConfig.Ensure().vars;
  }

  public static async Load(): Promise<void> {
    if (!existsSync(path.dirname(DaemonConfig.configPath))) {
      await fs.mkdir(path.dirname(DaemonConfig.configPath), {
        recursive: true,
      });
    }

    let shouldSave = true;
    if (existsSync(DaemonConfig.configPath)) {
      const configStr = await fs.readFile(DaemonConfig.configPath, "utf-8");

      try {
        const parsed = JSON.parse(configStr);
        // Backfill every field missing from configs written by older daemons.
        // A missing stateBackend used to read as undefined, which callers
        // treated as "json" even though the default is "sqlite".
        shouldSave = fillMissing(parsed, new DaemonConfig().vars);
        DaemonConfig.Ensure().vars = parsed;
      } catch (e) {
        //
      }
    }

    if (shouldSave) {
      await DaemonConfig.Save();
    }

    DaemonConfig.loaded = true;
  }

  public static async Save(): Promise<void> {
    if (!existsSync(path.dirname(DaemonConfig.configPath))) {
      await fs.mkdir(path.dirname(DaemonConfig.configPath), {
        recursive: true,
      });
    }

    await fs.writeFile(
      DaemonConfig.configPath,
      JSON.stringify(DaemonConfig.Ensure().vars, null, 2),
      "utf-8",
    );
  }
}
