import pino, { type Logger as PinoLogger } from "pino";
import fs from "fs";
import path from "path";
import { format } from "date-fns";
import pretty from "pino-pretty"; // this ensures pkg will bundle it
import config from "@incanta/config";

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
export const CustomLevels: Record<CustomLevelNames, number> = {
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

interface LoggingConfig {
  level: string;
  prettify: {
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
    enabled: boolean;
    level: string;
    path: string;
    maxArchivedFiles: number;
  };
}

export let Logger: PinoLogger<CustomLevelNames>;

export function SetLogger(newLogger: PinoLogger<CustomLevelNames>): void {
  Logger = newLogger;
}

export async function InitLogger(): Promise<void> {
  const loggingConfig = config.get<LoggingConfig>("logging");

  const include = loggingConfig.prettify.include;

  const streams: (pino.DestinationStream | pino.StreamEntry<LevelNames>)[] = [
    {
      level: loggingConfig.level as LevelNames,
      stream: loggingConfig.prettify.include
        ? pretty({
            colorize: loggingConfig.prettify.colorize,
            colorizeObjects: loggingConfig.prettify.colorizeObjects,
            crlf: loggingConfig.prettify.crlf,
            levelFirst: loggingConfig.prettify.levelFirst,
            messageFormat: loggingConfig.prettify.messageFormat,
            translateTime: loggingConfig.prettify.translateTime,
            ignore: loggingConfig.prettify.ignore.join(","),
            include: include.length === 0 ? undefined : include.join(","),
            hideObject: loggingConfig.prettify.hideObject,
            singleLine: loggingConfig.prettify.singleLine,
            customColors: CustomColors,
          })
        : process.stdout,
    },
  ];

  const logToFile = loggingConfig.logFile.enabled;
  if (logToFile) {
    const logFilePath = path.resolve(process.cwd(), loggingConfig.logFile.path);
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

    const maxArchivedFiles = loggingConfig.logFile.maxArchivedFiles;

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
      level: loggingConfig.logFile.level as LevelNames,
      stream: fs.createWriteStream(logFilePath),
    });
  }

  const normalLevel = loggingConfig.level as LevelNames;
  const fileLevel = loggingConfig.logFile.level as LevelNames;

  const normalLevelNum = pino.levels.values[normalLevel];
  const fileLevelNum = pino.levels.values[fileLevel];

  Logger = pino<CustomLevelNames>(
    {
      level:
        !logToFile ||
        (normalLevelNum && fileLevelNum && normalLevelNum < fileLevelNum)
          ? normalLevel
          : fileLevel,
      customLevels: CustomLevels,
    },
    pino.multistream(streams),
  );
}

// this just makes sure Logger is always defined, but the DaemonManager init
// will set it properly on startup
Logger = pino<CustomLevelNames>();
