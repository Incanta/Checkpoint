import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

// The main process only logs to the console, which nobody sees in a packaged
// build. This copies console output to a file in the app's logs folder so a
// bug report bundle can include it. One previous file is kept, and each is
// capped, so the folder stays small.

const MAX_BYTES = 5 * 1024 * 1024;
const LOG_NAME = "main.log";
const OLD_LOG_NAME = "main.old.log";

let logDir: string | null = null;
let fd: number | null = null;
let size = 0;

function resolveLogDir(): string {
  try {
    return app.getPath("logs");
  } catch {
    return path.join(app.getPath("userData"), "logs");
  }
}

function rotate(): void {
  if (!logDir) return;
  try {
    if (fd !== null) fs.closeSync(fd);
    fs.renameSync(path.join(logDir, LOG_NAME), path.join(logDir, OLD_LOG_NAME));
  } catch {
    // Keep appending to the current file.
  }
  fd = fs.openSync(path.join(logDir, LOG_NAME), "a");
  size = fs.fstatSync(fd).size;
}

function writeLine(level: string, args: unknown[]): void {
  if (fd === null) return;
  try {
    const line = `${new Date().toISOString()} [${level}] ${format(...args)}\n`;
    const data = Buffer.from(line, "utf8");
    fs.writeSync(fd, data);
    size += data.length;
    if (size >= MAX_BYTES) rotate();
  } catch {
    // Logging must never break the app.
  }
}

/** Starts copying console output to the log file. Call once, early. */
export function initMainLogFile(): void {
  if (fd !== null) return;
  try {
    logDir = resolveLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    // A new session starts a new file; the last session's becomes the old one.
    if (fs.existsSync(path.join(logDir, LOG_NAME))) {
      fs.renameSync(
        path.join(logDir, LOG_NAME),
        path.join(logDir, OLD_LOG_NAME),
      );
    }
    fd = fs.openSync(path.join(logDir, LOG_NAME), "a");
    size = fs.fstatSync(fd).size;
  } catch {
    fd = null;
    return;
  }

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      writeLine(level, args);
    };
  }

  writeLine("info", [
    `Checkpoint desktop ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`,
  ]);
}

/** The main-process log files that exist, newest first, with their tails. */
export function readMainLogFiles(
  maxBytesEach = MAX_BYTES,
): { name: string; content: string }[] {
  const dir = logDir ?? resolveLogDir();
  const out: { name: string; content: string }[] = [];
  for (const name of [LOG_NAME, OLD_LOG_NAME]) {
    const file = path.join(dir, name);
    try {
      const { size: fileSize } = fs.statSync(file);
      const start = Math.max(0, fileSize - maxBytesEach);
      const buffer = Buffer.alloc(fileSize - start);
      const handle = fs.openSync(file, "r");
      try {
        fs.readSync(handle, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(handle);
      }
      out.push({ name: `desktop-${name}`, content: buffer.toString("utf8") });
    } catch {
      // Not there.
    }
  }
  return out;
}
