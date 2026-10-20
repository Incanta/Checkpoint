import pino, { type Logger as PinoLogger } from "pino";
import fs from "fs";
import path from "path";
import { homedir } from "os";
import { format } from "date-fns";
import pretty from "pino-pretty"; // this ensures pkg will bundle it
import { DaemonConfig, type DaemonConfigType } from "./daemon-config.js";

// To add custom levels, you need to define this type with each of the names
// and specify the order levels in CustomLevels. This will enable a typed
// logger from createLogger which you can use in your backend code.
// Use the commented parts as an example.
export type CustomLevelNames = "log"; // e.g. "log" | "foo";

type LevelNames =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | CustomLevelNames;

// The default levels are:
//   fatal: 60
//   error: 50
//   warn:  40
//   info:  30
//   debug: 20
//   trace: 10
export const CustomLevels: { [level in CustomLevelNames]: number } = {
  log: 100,
  // foo: 25,
};

export const CustomColors: Record<string, string> = {
  default: "white",
  60: "bgRed",
  50: "red",
  40: "yellow",
  30: "green",
  20: "blue",
  10: "gray",
  message: "cyan",
  greyMessage: "gray",
  log: "magenta",
  // foo: "red",
};

export let Logger: PinoLogger<CustomLevelNames>;

export function SetLogger(newLogger: PinoLogger<CustomLevelNames>): void {
  Logger = newLogger;
}

/**
 * Where the resident daemon writes its log. A relative configured path is
 * resolved under ~/.checkpoint rather than process.cwd(), which is
 * unpredictable when the daemon runs as a system service (e.g.
 * C:\Windows\System32).
 */
export function ResolveLogFilePath(
  config: Pick<DaemonConfigType, "logging">,
): string {
  const configuredPath = config.logging.logFile.path;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(homedir(), ".checkpoint", configuredPath);
}

/**
 * Ephemeral daemons (spawned by the CLI when no resident daemon runs) log
 * beside the resident one under their own name. Sharing daemon.log would
 * archive the resident daemon's log out from under it on every CLI command.
 * The prefix goes in front so the resident log's "daemon-" archive pruning
 * never counts these.
 */
export function EphemeralLogFilePath(residentPath: string): string {
  return path.join(
    path.dirname(residentPath),
    `ephemeral-${path.basename(residentPath)}`,
  );
}

function archiveName(logFilePath: string): string {
  const extName = path.extname(logFilePath);
  const stem = path.join(
    path.dirname(logFilePath),
    path.basename(logFilePath, extName),
  );
  const now = new Date();
  const archived = `${stem}-${format(now, "y.MM.dd-HH.mm.ss")}${extName}`;
  // Two archives in one second (a size rotation right after startup) must
  // not overwrite each other.
  return fs.existsSync(archived)
    ? `${stem}-${format(now, "y.MM.dd-HH.mm.ss.SSS")}${extName}`
    : archived;
}

function pruneArchives(logFilePath: string, maxArchivedFiles: number): void {
  if (maxArchivedFiles < 0) return;
  const extName = path.extname(logFilePath);
  const logFiles = fs
    .readdirSync(path.dirname(logFilePath))
    .filter((f) => f.startsWith(`${path.basename(logFilePath, extName)}-`));

  const numToRemove = logFiles.length - maxArchivedFiles;
  const filesToRemove = logFiles.sort().slice(0, numToRemove);

  for (const file of filesToRemove) {
    try {
      fs.unlinkSync(path.join(path.dirname(logFilePath), file));
    } catch {
      // Open elsewhere (Windows); the next rotation tries again.
    }
  }
}

/**
 * A log file that is archived and started over once it passes `maxBytes`,
 * so a daemon left running for weeks cannot fill the disk. Writes are
 * synchronous, which keeps rotation free of races and loses nothing on a
 * crash.
 */
export class RotatingLogFile {
  private fd: number;
  private size: number;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
    private readonly maxArchivedFiles: number,
  ) {
    this.fd = fs.openSync(filePath, "a");
    this.size = fs.fstatSync(this.fd).size;
  }

  write(chunk: string): boolean {
    try {
      const data = Buffer.from(chunk, "utf8");
      fs.writeSync(this.fd, data);
      this.size += data.length;
      if (this.maxBytes > 0 && this.size >= this.maxBytes) {
        this.rotate();
      }
    } catch {
      // A full disk or a vanished log directory must not take the daemon
      // down with it.
    }
    return true;
  }

  private rotate(): void {
    fs.closeSync(this.fd);
    try {
      fs.renameSync(this.filePath, archiveName(this.filePath));
      pruneArchives(this.filePath, this.maxArchivedFiles);
    } catch {
      // Could not archive (locked); keep appending to the same file.
    }
    this.fd = fs.openSync(this.filePath, "a");
    this.size = fs.fstatSync(this.fd).size;
  }
}

export async function InitLogger(
  options: { ephemeral?: boolean } = {},
): Promise<void> {
  const config = await DaemonConfig.Get();

  const include = config.logging.prettify.include;

  const streams: (pino.DestinationStream | pino.StreamEntry<LevelNames>)[] = [
    {
      level: config.logging.level as LevelNames,
      stream: config.logging.prettify.enabled
        ? pretty({
            colorize: config.logging.prettify.colorize,
            colorizeObjects: config.logging.prettify.colorizeObjects,
            crlf: config.logging.prettify.crlf,
            levelFirst: config.logging.prettify.levelFirst,
            messageFormat: config.logging.prettify.messageFormat,
            translateTime: config.logging.prettify.translateTime,
            ignore: config.logging.prettify.ignore.join(","),
            include: include.length === 0 ? undefined : include.join(","),
            hideObject: config.logging.prettify.hideObject,
            singleLine: config.logging.prettify.singleLine,
            customColors: CustomColors,
          })
        : process.stdout,
    },
  ];

  // Always write a daemon log file so the tray's "View Logs" action, bug
  // report bundles (see util/bug-report.ts), and support workflows have
  // something to inspect, even when the daemon fails early. Each start
  // archives the previous log, and a log that grows past maxFileSizeMB is
  // archived too, keeping maxArchivedFiles of them.
  const logToFile = true;
  if (logToFile) {
    const residentPath = ResolveLogFilePath(config);
    const logFilePath = options.ephemeral
      ? EphemeralLogFilePath(residentPath)
      : residentPath;

    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

    if (fs.existsSync(logFilePath)) {
      try {
        fs.renameSync(logFilePath, archiveName(logFilePath));
      } catch {
        // Still open in another daemon process (Windows); append to it.
      }
    }

    const maxArchivedFiles = config.logging.logFile.maxArchivedFiles;
    pruneArchives(logFilePath, maxArchivedFiles);

    const maxSizeMB = config.logging.logFile.maxFileSizeMB ?? 20;
    streams.push({
      level: config.logging.logFile.level as LevelNames,
      stream: new RotatingLogFile(
        logFilePath,
        Math.max(0, maxSizeMB) * 1024 * 1024,
        maxArchivedFiles,
      ),
    });
  }

  const normalLevel = config.logging.level as LevelNames;
  const fileLevel = config.logging.logFile.level as LevelNames;

  const normalLevelNum = pino.levels.values[normalLevel];
  const fileLevelNum = pino.levels.values[fileLevel];

  Logger = pino<CustomLevelNames>(
    {
      level:
        !logToFile || normalLevelNum < fileLevelNum ? normalLevel : fileLevel,
      customLevels: CustomLevels,
    },
    pino.multistream(streams),
  );
}

// this just makes sure Logger is always defined, but the DaemonManager init
// will set it properly on startup
Logger = pino<CustomLevelNames>();
