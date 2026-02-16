import { existsSync, promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import type { Workspace } from "./types/index.js";

export interface DaemonConfigType {
  workspaces: Workspace[];
  logging: {
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
  };
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
      workspaces: [],
      logging: {
        level: "info",
        prettify: {
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
        },
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
        DaemonConfig.Ensure().vars = JSON.parse(configStr);
        shouldSave = false;
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
