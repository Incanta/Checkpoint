import {
  promises as fs,
  existsSync,
  createWriteStream,
  readFileSync,
} from "fs";
import path from "path";
import { homedir, platform, arch } from "os";
import https from "https";
import http from "http";
import { Logger } from "./logging.js";

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checking: boolean;
  downloading: boolean;
  downloadProgress: number;
  downloadedInstallerPath: string | null;
  lastCheckTime: number | null;
  lastError: string | null;
}

export interface UpdaterConfig {
  /** GitHub repository in "owner/repo" format */
  repository: string;
  /** Check interval in milliseconds (default: 6 hours) */
  checkIntervalMs: number;
  /** Whether auto-check is enabled */
  enabled: boolean;
}

const DEFAULT_CONFIG: UpdaterConfig = {
  repository: "Incanta/Checkpoint",
  checkIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  enabled: true,
};

interface GitHubRelease {
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
  html_url: string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

function getCurrentVersion(): string {
  // In SEA builds, version is injected via esbuild define
  const envVersion = process.env["CHECKPOINT_VERSION"];
  if (envVersion) return envVersion;

  // Fallback: try reading VERSION file relative to executable
  try {
    const versionFile = path.join(path.dirname(process.execPath), "VERSION");
    if (existsSync(versionFile)) {
      return (readFileSync(versionFile, "utf-8") as string).trim();
    }
  } catch {
    // ignore
  }

  return "0.0.0-dev";
}

function getInstallerAssetPattern(): string {
  const p = platform();
  const a = arch();

  switch (p) {
    case "win32":
      return "Checkpoint-Windows-x64-.*-Setup\\.exe$";
    case "linux":
      return "Checkpoint-Linux-amd64-.*\\.deb$";
    case "darwin":
      if (a === "arm64") {
        return "Checkpoint-macOS-arm64-.*\\.pkg$";
      }
      return "Checkpoint-macOS-x64-.*\\.pkg$";
    default:
      return "";
  }
}

function compareVersions(a: string, b: string): number {
  // Strip leading 'v' if present
  const va = a.replace(/^v/, "").split(".").map(Number);
  const vb = b.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const na = va[i] ?? 0;
    const nb = vb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function httpsGet(url: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const makeRequest = (reqUrl: string, redirectCount: number): void => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      https
        .get(
          reqUrl,
          {
            headers: {
              "User-Agent": "Checkpoint-Daemon-Updater",
              Accept: "application/vnd.github+json",
            },
          },
          (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              makeRequest(res.headers.location, redirectCount + 1);
              return;
            }

            let body = "";
            res.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on("end", () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body,
              });
            });
            res.on("error", reject);
          },
        )
        .on("error", reject);
    };

    makeRequest(url, 0);
  });
}

function downloadFile(
  url: string,
  destPath: string,
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const makeRequest = (reqUrl: string, redirectCount: number): void => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      const proto = reqUrl.startsWith("https") ? https : http;
      proto
        .get(
          reqUrl,
          {
            headers: { "User-Agent": "Checkpoint-Daemon-Updater" },
          },
          (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              makeRequest(res.headers.location, redirectCount + 1);
              return;
            }

            if (res.statusCode !== 200) {
              reject(
                new Error(`Download failed with status ${res.statusCode}`),
              );
              return;
            }

            const totalSize = parseInt(
              res.headers["content-length"] ?? "0",
              10,
            );
            let downloaded = 0;

            const file = createWriteStream(destPath);
            res.on("data", (chunk: Buffer) => {
              downloaded += chunk.length;
              onProgress(downloaded, totalSize);
            });
            res.pipe(file);
            file.on("finish", () => {
              file.close();
              resolve();
            });
            file.on("error", (err) => {
              fs.unlink(destPath).catch(() => {});
              reject(err);
            });
            res.on("error", (err) => {
              fs.unlink(destPath).catch(() => {});
              reject(err);
            });
          },
        )
        .on("error", reject);
    };

    makeRequest(url, 0);
  });
}

export class Updater {
  private config: UpdaterConfig;
  private status: UpdateStatus;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<UpdaterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.status = {
      currentVersion: getCurrentVersion(),
      latestVersion: null,
      updateAvailable: false,
      checking: false,
      downloading: false,
      downloadProgress: 0,
      downloadedInstallerPath: null,
      lastCheckTime: null,
      lastError: null,
    };
  }

  public start(): void {
    if (!this.config.enabled) {
      Logger.info("Auto-update checking is disabled");
      return;
    }

    Logger.info(
      `Starting update checker (interval: ${this.config.checkIntervalMs / 1000 / 60}min, repo: ${this.config.repository})`,
    );

    // Check immediately on start, then on interval
    void this.checkForUpdates();

    this.checkInterval = setInterval(() => {
      void this.checkForUpdates();
    }, this.config.checkIntervalMs);
  }

  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  public getStatus(): UpdateStatus {
    return { ...this.status };
  }

  public async checkForUpdates(): Promise<UpdateStatus> {
    if (this.status.checking) {
      return this.getStatus();
    }

    this.status.checking = true;
    this.status.lastError = null;

    try {
      const url = `https://api.github.com/repos/${this.config.repository}/releases/latest`;
      Logger.info(`Checking for updates: ${url}`);

      const response = await httpsGet(url);

      if (response.statusCode !== 200) {
        throw new Error(
          `GitHub API returned status ${response.statusCode}: ${response.body.substring(0, 200)}`,
        );
      }

      const release = JSON.parse(response.body) as GitHubRelease;

      if (release.draft || release.prerelease) {
        Logger.info("Latest release is draft/prerelease, skipping");
        this.status.lastCheckTime = Date.now();
        return this.getStatus();
      }

      const latestVersion = release.tag_name.replace(/^v/, "");
      this.status.latestVersion = latestVersion;
      this.status.lastCheckTime = Date.now();

      if (compareVersions(latestVersion, this.status.currentVersion) > 0) {
        this.status.updateAvailable = true;
        Logger.info(
          `Update available: ${this.status.currentVersion} → ${latestVersion}`,
        );
      } else {
        this.status.updateAvailable = false;
        Logger.info(
          `Up to date (current: ${this.status.currentVersion}, latest: ${latestVersion})`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.lastError = message;
      Logger.error(`Update check failed: ${message}`);
    } finally {
      this.status.checking = false;
    }

    return this.getStatus();
  }

  public async downloadUpdate(): Promise<string | null> {
    if (!this.status.updateAvailable || !this.status.latestVersion) {
      Logger.warn("No update available to download");
      return null;
    }

    if (this.status.downloading) {
      Logger.warn("Download already in progress");
      return null;
    }

    this.status.downloading = true;
    this.status.downloadProgress = 0;
    this.status.lastError = null;

    try {
      // Fetch release info again to get asset URLs
      const url = `https://api.github.com/repos/${this.config.repository}/releases/latest`;
      const response = await httpsGet(url);

      if (response.statusCode !== 200) {
        throw new Error(`GitHub API returned status ${response.statusCode}`);
      }

      const release = JSON.parse(response.body) as GitHubRelease;
      const pattern = getInstallerAssetPattern();

      if (!pattern) {
        throw new Error(`Unsupported platform: ${platform()}-${arch()}`);
      }

      const regex = new RegExp(pattern);
      const asset = release.assets.find((a) => regex.test(a.name));

      if (!asset) {
        throw new Error(
          `No installer asset found for ${platform()}-${arch()} in release ${release.tag_name}`,
        );
      }

      Logger.info(`Downloading update: ${asset.name} (${asset.size} bytes)`);

      const downloadDir = path.join(homedir(), ".checkpoint", "updates");
      await fs.mkdir(downloadDir, { recursive: true });

      const destPath = path.join(downloadDir, asset.name);

      await downloadFile(
        asset.browser_download_url,
        destPath,
        (downloaded, total) => {
          this.status.downloadProgress =
            total > 0 ? Math.round((downloaded / total) * 100) : 0;
        },
      );

      this.status.downloadedInstallerPath = destPath;
      this.status.downloadProgress = 100;
      Logger.info(`Update downloaded to: ${destPath}`);

      return destPath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.lastError = message;
      Logger.error(`Download failed: ${message}`);
      return null;
    } finally {
      this.status.downloading = false;
    }
  }

  public async applyUpdate(): Promise<void> {
    const installerPath = this.status.downloadedInstallerPath;

    if (!installerPath || !existsSync(installerPath)) {
      throw new Error("No downloaded installer available");
    }

    Logger.info(`Applying update from: ${installerPath}`);

    const p = platform();

    // Launch the installer as a detached process and exit the daemon.
    // The installer will stop the old service, install the new version,
    // and start the new service.
    const { spawn } = await import("child_process");

    switch (p) {
      case "win32":
        // NSIS installer supports /S for silent mode
        spawn(installerPath, ["/S"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        break;

      case "darwin":
        // macOS .pkg can be installed with the `installer` command
        spawn("sudo", ["installer", "-pkg", installerPath, "-target", "/"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        break;

      case "linux":
        if (installerPath.endsWith(".deb")) {
          spawn("sudo", ["dpkg", "-i", installerPath], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } else if (installerPath.endsWith(".rpm")) {
          spawn("sudo", ["rpm", "-U", installerPath], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
        break;
    }

    // Give the installer a moment to start, then exit
    Logger.info("Installer launched, daemon will exit for update...");
    setTimeout(() => {
      process.exit(0);
    }, 2000);
  }
}

// Singleton instance
let updaterInstance: Updater | null = null;

export function getUpdater(config?: Partial<UpdaterConfig>): Updater {
  if (!updaterInstance) {
    updaterInstance = new Updater(config);
  }
  return updaterInstance;
}
