import config from "@incanta/config";
import { spawn } from "child_process";
import path from "path";
import { IChangesetManifest } from "./types";

export interface ILongtailOptions {
  version: string;
  localPath?: string;
  remotePath?: string;
}

export class Longtail {
  public static getExecutablePath(): string {
    const exePath =
      process.env.LONGTAIL_PATH ||
      config.get<string>("longtail.executable.path");
    const exeName = config.get<string>("longtail.executable.name");
    const longtailPath = path.join(exePath, exeName);
    return longtailPath;
  }

  public static getEnvironmentVariables(): any {
    const env: any = {};

    return env;
  }

  public static getRemoteStore(version: string, targetPath?: string): string {
    return `${targetPath ? targetPath + path.sep : ""}${version}.json`;
  }

  public static processStdOut(prefix: string, data: string): void {
    const regex = new RegExp(`${prefix} +(?<percent>[0-9]+)`, "g");
    // const match = regex.exec(data);
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = regex.exec(data)) !== null) {
      if (typeof match.groups?.percent === "string") {
        console.log(`${prefix}: ${match.groups.percent}%`);
      }
    }
  }

  public static async execLongtail(args: string[]): Promise<void> {
    args.push("--log-to-console");

    const child = spawn(Longtail.getExecutablePath(), args, {
      env: Longtail.getEnvironmentVariables(),
    });

    await new Promise<void>((resolve, reject) => {
      if (child.stdout) {
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (data: string) => {
          if (data.includes("Writing content blocks")) {
            Longtail.processStdOut("Writing content blocks", data);
          } else if (data.includes("Indexing version")) {
            Longtail.processStdOut("Indexing version", data);
          } else if (data.includes("Updating version")) {
            Longtail.processStdOut("Updating version", data);
          } else {
            console.log(data);
          }
        });
      }

      let errors = "";
      if (child.stderr) {
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (data) => {
          errors += data;
        });
      }

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Longtail exited with code: ${code}. Logged stderr: ${errors}`
            )
          );
        }
      });
    });
  }

  public static async put(
    options: ILongtailOptions,
    files: string[] = []
  ): Promise<void> {
    const args = [
      "put",
      "--source-path",
      options.localPath || config.get<string>("storage.local.path"),
      "--target-path",
      Longtail.getRemoteStore(options.version, options.remotePath),
      "--exclude-filter-regex",
      config
        .get<string[] | undefined>("longtail.exclude-filter-regex")
        ?.join("**") || "",
      "--min-block-usage-percent",
      `${config.get<number>("longtail.min-block-usage-percent")}`,
    ];

    if (files.length > 0) {
      args.push("--include-filter-regex", files.join("**"));
    }

    await Longtail.execLongtail(args);
  }

  public static async commit(
    baseVersion: string,
    manifest: IChangesetManifest,
    options: ILongtailOptions
  ): Promise<void> {
    const args = [
      "commit",
      "--source-path",
      options.localPath || config.get<string>("storage.local.path"),
      "--base-target-path",
      Longtail.getRemoteStore(baseVersion, options.remotePath),
      "--target-path",
      Longtail.getRemoteStore(options.version, options.remotePath),
      "--exclude-filter-regex",
      config
        .get<string[] | undefined>("longtail.exclude-filter-regex")
        ?.join("**") || "",
      "--min-block-usage-percent",
      `${config.get<number>("longtail.min-block-usage-percent")}`,
    ];

    const includedFiles = manifest.files.filter((f) => f.type !== "delete");

    if (includedFiles.length > 0) {
      args.push(
        "--include-filter-regex",
        includedFiles.map((f) => path.join(f.path, f.name)).join("**")
      );
    } else {
      args.push("--include-filter-regex", "__NO_FILES_INCLUDED__");
    }

    const removedFiles = manifest.files.filter((f) => f.type === "delete");

    if (removedFiles.length > 0) {
      args.push(
        "--removed-files",
        removedFiles.map((f) => path.join(f.path, f.name)).join("**")
      );
    }

    await Longtail.execLongtail(args);
  }

  public static async get(options: ILongtailOptions): Promise<void> {
    const args = [
      "get",
      "--target-path",
      options.localPath || config.get<string>("storage.local.path"),
      "--source-path",
      Longtail.getRemoteStore(options.version, options.remotePath),
    ];

    if (config.get<boolean>("storage.cache.enabled")) {
      args.push(
        "--cache-path",
        path.join(
          options.localPath || config.get<string>("storage.local.path"),
          config.get<string>("storage.cache.path")
        )
      );
    }

    await this.execLongtail(args);
  }
}
