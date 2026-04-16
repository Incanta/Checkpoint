import pino from "pino";
import config from "@incanta/config";

interface LoggingConfig {
  level: string;
  prettify: {
    enabled: boolean;
    colorize: boolean;
    translateTime: string;
    singleLine: boolean;
  };
}

const loggingConfig = config.get<LoggingConfig>("logging");

export const Logger = pino({
  level: loggingConfig.level,
  ...(loggingConfig.prettify.enabled
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: loggingConfig.prettify.colorize,
            translateTime: loggingConfig.prettify.translateTime,
            singleLine: loggingConfig.prettify.singleLine,
          },
        },
      }
    : {}),
});
