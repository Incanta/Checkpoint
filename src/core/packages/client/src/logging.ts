import pino, { Logger as PinoLogger } from "pino";
import "pino-pretty"; // this ensures pkg will bundle it
import { CheckpointConfig } from "./config";

export function GetLogger(config: CheckpointConfig): PinoLogger {
  return pino({
    level: config.logging.level,
    transport: config.logging.prettify.enabled
      ? {
          target: "pino-pretty",
          options: {
            colorize: config.logging.prettify.colorize,
            colorizeObjects: config.logging.prettify.colorizeObjects,
            crlf: config.logging.prettify.crlf,
            levelFirst: config.logging.prettify.levelFirst,
            messageFormat: config.logging.prettify.messageFormat,
            translateTime: config.logging.prettify.translateTime,
            ignore: config.logging.prettify.ignore.join(","),
            include: config.logging.prettify.include.join(","),
            hideObject: config.logging.prettify.hideObject,
            singleLine: config.logging.prettify.singleLine,
          },
        }
      : undefined,
  });
}
