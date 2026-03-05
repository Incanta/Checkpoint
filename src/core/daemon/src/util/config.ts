import { existsSync, promises as fs } from "fs";
import path from "path";

export interface CheckpointConfig {
  configVersion: number;
  remote: {
    server: string;
    organization: string;
    repository: string;
  };
  logging: {
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    prettify: {
      enabled: boolean;
      colorize: boolean;
      colorizeObjects: boolean;
      crlf: boolean;
      levelFirst: boolean;
      messageFormat: boolean;
      translateTime: string;
      ignore: string[];
      include: string[];
      hideObject: boolean;
      singleLine: boolean;
    };
  };
}

export const DefaultLoggingConfig: CheckpointConfig["logging"] = {
  level: "info",
  prettify: {
    enabled: true,
    colorize: true,
    colorizeObjects: true,
    crlf: true,
    levelFirst: false,
    messageFormat: false,
    translateTime: "HH:MM:ss.l",
    ignore: ["hostname"],
    include: [],
    hideObject: false,
    singleLine: false,
  },
};

export const DefaultConfig: CheckpointConfig = {
  configVersion: 1,
  remote: {
    server: "",
    organization: "",
    repository: "",
  },
  logging: DefaultLoggingConfig,
};
