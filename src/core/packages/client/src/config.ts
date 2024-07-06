import { existsSync, promises as fs } from "fs";
import path from "path";

export interface CheckpointConfig {
  configVersion: number;
  gitRoot: string;
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
  gitRoot: "",
  logging: DefaultLoggingConfig,
};

export async function getConfig(gitRoot: string): Promise<CheckpointConfig> {
  const configPath = path.join(gitRoot, ".checkpoint", "config.json");

  if (!existsSync(configPath)) {
    return DefaultConfig;
  }

  const config = await fs.readFile(configPath, "utf-8");

  const overrideConfigPath = path.join(
    gitRoot,
    ".checkpoint",
    "config-override.json"
  );

  let overrideConfig: string = "{}";
  if (existsSync(overrideConfigPath)) {
    overrideConfig = await fs.readFile(overrideConfigPath, "utf-8");
  }

  return {
    ...DefaultConfig,
    ...JSON.parse(config),
    ...JSON.parse(overrideConfig),
    gitRoot,
  };
}
