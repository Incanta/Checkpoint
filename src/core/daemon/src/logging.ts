import pino, { type Logger as PinoLogger } from "pino";
import fs from "fs";
import path from "path";
import { format } from "date-fns";
import pretty from "pino-pretty"; // this ensures pkg will bundle it
import { DaemonConfig } from "./daemon-config.js";

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

export async function InitLogger(): Promise<void> {
  const config = await DaemonConfig.Get();

  const include = config.logging.prettify.include;

  const streams: (pino.DestinationStream | pino.StreamEntry<LevelNames>)[] = [
    {
      level: config.logging.level as LevelNames,
      stream: config.logging.prettify.include
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

  const logToFile = config.logging.logFile.enabled;
  if (logToFile) {
    const logFilePath = path.resolve(
      process.cwd(),
      config.logging.logFile.path,
    );
    const extName = path.extname(logFilePath);

    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

    if (fs.existsSync(logFilePath)) {
      const formattedDate = format(new Date(), "y.MM.dd-HH.mm.ss");
      fs.renameSync(
        logFilePath,
        path.join(
          path.dirname(logFilePath),
          `${path.basename(logFilePath, extName)}-${formattedDate}${extName}`,
        ),
      );
    }

    const maxArchivedFiles = config.logging.logFile.maxArchivedFiles;

    if (maxArchivedFiles >= 0) {
      const logFiles = fs
        .readdirSync(path.dirname(logFilePath))
        .filter((f) => f.startsWith(`${path.basename(logFilePath, extName)}-`));

      const numToRemove = logFiles.length - maxArchivedFiles;
      const filesToRemove = logFiles.sort().slice(0, numToRemove);

      for (const file of filesToRemove) {
        fs.unlinkSync(path.join(path.dirname(logFilePath), file));
      }
    }

    streams.push({
      level: config.logging.logFile.level as LevelNames,
      stream: fs.createWriteStream(logFilePath),
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
