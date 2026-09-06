import "server-only";

import { existsSync, promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

import { Logger } from "~/server/logging";

/**
 * Reads and drives the deployment state volume shared with the runtime
 * container's bootstrap (docker/runtime/bootstrap.js).
 *
 * The layout below is defined by that script; this module mirrors it rather
 * than importing it, because the app and the bootstrap only share a filesystem,
 * not a module graph:
 *
 *   $CHECKPOINT_STATE_DIR/
 *     bundles/<component>/<version>[-<provider>]/   extracted bundles
 *     state/desired.json                            what SHOULD be running
 *     state/app.json, state/server.json             what IS running
 *
 * Staging and verification are deliberately NOT reimplemented here. The panel
 * shells out to the bootstrap's `--stage` mode so signature checking has
 * exactly one implementation, the one the container boots with.
 */

export type BundleMode = "channel" | "pinned" | "local";
export type BundleComponent = "app" | "server";

export interface ComponentState {
  component: BundleComponent;
  active: string;
  /** Release tag the active version's assets live on, as recorded at boot. */
  activeReleaseTag: string | null;
  previous: string | null;
  /** Same, for `previous`. Null on state written before this was recorded. */
  previousReleaseTag: string | null;
  provider: string | null;
  mode: BundleMode;
  channel: string | null;
  runtimeAbi: string | null;
  selfUpdatable: boolean;
  startedAt: string;
  hostname: string;
}

export interface DesiredState {
  version: string;
  releaseTag: string | null;
  requestedBy: string | null;
  requestedAt: string;
}

export type StageStatus =
  | { state: "idle" }
  | { state: "staging"; version: string; component: BundleComponent }
  | { state: "staged"; version: string; stagedAt: string }
  | { state: "error"; version: string; message: string };

const STAGE_STATE = Symbol.for("checkpoint.bundleStage");

function getStageState(): { status: StageStatus } {
  const g = globalThis as unknown as Record<symbol, { status: StageStatus }>;
  g[STAGE_STATE] ??= { status: { state: "idle" } };
  return g[STAGE_STATE];
}

// ── Paths ────────────────────────────────────────────────────────

export function getStateDir(): string {
  return process.env.CHECKPOINT_STATE_DIR ?? "/var/lib/checkpoint";
}

function bootstrapPath(): string {
  return (
    process.env.CHECKPOINT_RUNTIME_BOOTSTRAP ?? "/app/runtime/bootstrap.js"
  );
}

/**
 * True when this process is running from a bundle under the runtime image.
 * Everything in the update panel is gated on this: a dev server or a legacy
 * baked image has no state volume and no bootstrap to hand off to.
 */
export function isBundleDeployment(): boolean {
  return (
    !!process.env.CHECKPOINT_BUNDLE_VERSION_ACTIVE &&
    existsSync(bootstrapPath())
  );
}

// ── Reads ────────────────────────────────────────────────────────

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readComponentState(
  component: BundleComponent,
): Promise<ComponentState | null> {
  return await readJson<ComponentState>(
    path.join(getStateDir(), "state", `${component}.json`),
  );
}

export async function readDesired(): Promise<DesiredState | null> {
  return await readJson<DesiredState>(
    path.join(getStateDir(), "state", "desired.json"),
  );
}

export function getStageStatus(): StageStatus {
  return getStageState().status;
}

/** Is a given version already extracted and ready to boot into? */
export async function isStaged(version: string): Promise<boolean> {
  // The app bundle's directory is provider-suffixed, matching bundleDir() in
  // docker/runtime/bootstrap.js.
  const app = await readComponentState("app");

  const dirs = [
    path.join(
      getStateDir(),
      "bundles",
      "app",
      `${version}-${app?.provider ?? "sqlite"}`,
    ),
    path.join(getStateDir(), "bundles", "server", version),
  ];

  // Both components must be present: installing writes one desired version and
  // restarts both, so a half-staged update would leave the server downloading
  // during its own restart window.
  return dirs.every((dir) => existsSync(path.join(dir, "bundle.json")));
}

// ── Staging ──────────────────────────────────────────────────────

function runBootstrapStage(
  component: BundleComponent,
  version: string,
  releaseTag: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      bootstrapPath(),
      "--stage",
      "--component",
      component,
      "--version",
      version,
    ];
    if (releaseTag) args.push("--tag", releaseTag);

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) =>
      Logger.info(`[Updates] ${chunk.toString().trimEnd()}`),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      Logger.warn(`[Updates] ${chunk.toString().trimEnd()}`);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          stderr.trim().split("\n").slice(-3).join(" ") ||
            `staging ${component} exited with code ${code}`,
        ),
      );
    });
  });
}

/**
 * Download and verify both bundles for a version without activating anything.
 *
 * Runs in the background: staging a release is a multi-hundred-megabyte
 * download, far longer than a tRPC call should hold open. Progress is polled
 * through getStageStatus(). Failures here cost no downtime, which is the whole
 * reason install is a separate step.
 */
export async function stageUpdate(
  version: string,
  releaseTag: string | null,
): Promise<void> {
  const state = getStageState();

  if (state.status.state === "staging") {
    throw new Error("A download is already in progress");
  }

  state.status = { state: "staging", version, component: "app" };

  try {
    for (const component of ["app", "server"] as const) {
      state.status = { state: "staging", version, component };
      await runBootstrapStage(component, version, releaseTag);
    }
    state.status = {
      state: "staged",
      version,
      stagedAt: new Date().toISOString(),
    };
    Logger.info(`[Updates] Staged ${version}; ready to install`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = { state: "error", version, message };
    Logger.error(`[Updates] Failed to stage ${version}: ${message}`);
  }
}

// ── Activation ───────────────────────────────────────────────────

async function writeDesired(desired: DesiredState): Promise<void> {
  const dir = path.join(getStateDir(), "state");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "desired.json");
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(desired, null, 2) + "\n");
  // Rename so a container reading this concurrently never sees a partial file.
  await fs.rename(tmp, file);
}

/**
 * Activate a staged version.
 *
 * Writing the desired version is the whole operation: the core server watches
 * this file and exits, and this process exits straight after. The restart
 * policy brings both back onto the new bundle, which is already extracted, so
 * the downtime is a process restart rather than a download.
 *
 * The exit is delayed so the mutation's HTTP response reaches the browser
 * first; otherwise the admin sees a network error rather than a restart.
 */
export async function applyUpdate(
  version: string,
  releaseTag: string | null,
  requestedBy: string | null,
): Promise<void> {
  if (!(await isStaged(version))) {
    throw new Error(
      `Version ${version} is not staged. Download it before installing.`,
    );
  }

  await writeDesired({
    version,
    releaseTag,
    requestedBy,
    requestedAt: new Date().toISOString(),
  });

  Logger.info(
    `[Updates] ${version} activated by ${requestedBy ?? "an admin"}; restarting`,
  );

  setTimeout(() => {
    Logger.info("[Updates] Exiting for restart onto the new bundle");
    process.exit(0);
  }, 2000);
}

/**
 * Return to the version that was running before the last update. The previous
 * bundle is still on disk (bootstrap keeps CHECKPOINT_BUNDLE_KEEP of them), so
 * this is the same restart, pointed backwards.
 */
export async function rollback(requestedBy: string | null): Promise<string> {
  const app = await readComponentState("app");
  if (!app?.previous) {
    throw new Error("No previous version is available to roll back to");
  }

  await writeDesired({
    // The tag recorded when that version was running. Falling back to
    // `v<version>` only covers state written before the tag was recorded, and
    // is right for every release-channel version; a nightly's assets live on
    // the rolling tag, so reconstructing one would 404 if the extracted bundle
    // has since been pruned.
    version: app.previous,
    releaseTag: app.previousReleaseTag ?? `v${app.previous}`,
    requestedBy,
    requestedAt: new Date().toISOString(),
  });

  Logger.warn(
    `[Updates] Rolling back to ${app.previous}, requested by ${requestedBy ?? "an admin"}`,
  );

  setTimeout(() => process.exit(0), 2000);
  return app.previous;
}
