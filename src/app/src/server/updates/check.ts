import "server-only";

import config from "@incanta/config";
import type { PrismaClient } from "@prisma/client";

import { Logger } from "~/server/logging";
import { SERVER_VERSION } from "~/server/api/api-version";
import { sendEmail, isEmailEnabled } from "~/server/email";
import { serverUpdateAvailableEmail } from "~/server/email/templates";

/**
 * Server-side update notifications.
 *
 * The desktop client can watch GitHub releases directly because installers are
 * release assets. Server builds are container images, so there is nothing on a
 * release to compare against. The CD pipeline therefore publishes a channel
 * manifest (scripts/build-channel-manifest.js) as a release asset on every run,
 * and this module polls it.
 *
 * Nothing is installed automatically: the operator gets an email naming the
 * version and the image tag to pull, and decides for themselves.
 */

interface ChannelManifestComponent {
  version?: string;
  /** Release tag holding this component's assets. */
  releaseTag?: string;
  channel?: string;
  runtimeAbi?: string | null;
  bundles?: {
    app?: { sqlite?: string; postgres?: string };
    server?: string;
  };
  updatedAt?: string;
  commit?: string;
}

interface ChannelManifest {
  schema?: number;
  channel?: string;
  updatedAt?: string;
  commit?: string;
  components?: Record<string, ChannelManifestComponent | undefined>;
}

export interface UpdateCheckResult {
  checked: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  notified: boolean;
  reason?: string;
}

// ── Config ───────────────────────────────────────────────────────

function readConfig<T>(key: string, fallback: T): T {
  try {
    const value = config.get<T>(`updates.${key}`);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Update awareness is opt-out, not opt-in.
 *
 * What actually makes it default-on is `enabled: true` in
 * config/default/updates.yaml, which ships inside the app bundle. An operator's
 * mounted config is the `local` layer merged OVER those defaults, so opting out
 * means adding `enabled: false` there; it does not mean the key goes missing.
 *
 * The `true` here is therefore only a floor for the case where the defaults
 * file is absent entirely, and it points the same way as the shipped default.
 */
export function isUpdateCheckEnabled(): boolean {
  return readConfig<boolean>("enabled", true) !== false;
}

export function getUpdateChannel(): "release" | "nightly" {
  return readConfig<string>("channel", "release") === "nightly"
    ? "nightly"
    : "release";
}

export function getCheckIntervalMs(): number {
  const hours = readConfig<number>("check-interval-hours", 6);
  // Guard against a config typo turning this into a hot loop.
  return Math.max(1, hours) * 60 * 60 * 1000;
}

/**
 * URL of the manifest for the configured channel.
 *
 * The release stream can use the `releases/latest/download/...` redirect
 * because nightlies are published with make_latest:false and never occupy that
 * slot. The nightly stream reads its fixed rolling tag.
 */
export function getManifestUrl(): string {
  const override = readConfig<string>("manifest-url", "");
  if (override) return override;

  const repository = readConfig<string>("repository", "Incanta/Checkpoint");
  const channel = getUpdateChannel();

  if (channel === "nightly") {
    const tag = readConfig<string>("nightly-tag", "nightly");
    return `https://github.com/${repository}/releases/download/${tag}/checkpoint-nightly.json`;
  }

  return `https://github.com/${repository}/releases/latest/download/checkpoint-release.json`;
}

// ── Version comparison ───────────────────────────────────────────

/**
 * Semver precedence including prereleases (semver.org rule 11).
 *
 * Deliberately local rather than imported from @checkpointvcs/common: the app
 * does not depend on common, and pulling it in for one comparison would create
 * a type cycle through common's AppRouter import.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } => {
    const stripped = v.replace(/^v/, "");
    const cleaned = stripped.split("+")[0] ?? stripped;
    const dash = cleaned.indexOf("-");
    const core = (dash === -1 ? cleaned : cleaned.slice(0, dash))
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
    const pre = dash === -1 ? [] : cleaned.slice(dash + 1).split(".");
    return { core, pre };
  };

  const va = parse(a);
  const vb = parse(b);

  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const na = va.core[i] ?? 0;
    const nb = vb.core[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;

  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const ia = va.pre[i];
    const ib = vb.pre[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;

    const numA = /^\d+$/.test(ia);
    const numB = /^\d+$/.test(ib);
    if (numA && numB) {
      const diff = parseInt(ia, 10) - parseInt(ib, 10);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (numA) return -1;
    if (numB) return 1;
    return ia > ib ? 1 : -1;
  }

  return 0;
}

// ── Recipients ───────────────────────────────────────────────────

async function resolveRecipients(db: PrismaClient): Promise<string[]> {
  const configured = readConfig<string[]>("notify-emails", []);
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.filter((e) => typeof e === "string" && e.includes("@"));
  }

  // Fall back to whoever set the instance up, so an operator who never touched
  // updates.yaml still hears about a pending upgrade.
  const settings = await db.instanceSettings.findUnique({
    where: { id: "default" },
    select: { setupCompletedBy: true },
  });
  if (!settings?.setupCompletedBy) return [];

  const user = await db.user.findUnique({
    where: { id: settings.setupCompletedBy },
    select: { email: true },
  });
  return user?.email ? [user.email] : [];
}

// ── Check ────────────────────────────────────────────────────────

async function fetchManifest(url: string): Promise<ChannelManifest | null> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    // Never let a hung request hold a scheduler tick open.
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) {
    Logger.debug(`[Updates] No manifest published yet at ${url}`);
    return null;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ChannelManifest;
}

const CHECK_CACHE = Symbol.for("checkpoint.updateCheckCache");

interface CheckCache {
  at: number;
  result: UpdateCheckResult;
}

// The admin panel polls getStatus every 30s while it is open, and every 2s
// while a download runs, so an uncached check would mean a request to GitHub
// on that same cadence for a value that changes at most daily.
const CHECK_CACHE_TTL_MS = 5 * 60 * 1000;

function getCache(): { entry: CheckCache | null } {
  const g = globalThis as unknown as Record<
    symbol,
    { entry: CheckCache | null }
  >;
  g[CHECK_CACHE] ??= { entry: null };
  return g[CHECK_CACHE];
}

/**
 * Poll the channel manifest and email the operator when it carries a newer
 * server build. Safe to call on any instance: it self-gates on config.
 *
 * Results are cached briefly. Pass `force` for a genuine check, which the
 * scheduler and the panel's "Check now" button both do; everything else is
 * happy with a recent answer.
 */
export async function checkForServerUpdate(
  db: PrismaClient,
  options: { force?: boolean } = {},
): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = {
    checked: false,
    currentVersion: SERVER_VERSION,
    latestVersion: null,
    updateAvailable: false,
    notified: false,
  };

  if (!isUpdateCheckEnabled()) {
    return { ...base, reason: "updates.enabled is false" };
  }

  const cache = getCache();
  if (
    !options.force &&
    cache.entry &&
    Date.now() - cache.entry.at < CHECK_CACHE_TTL_MS
  ) {
    return cache.entry.result;
  }

  const result = await runUpdateCheck(db, base);
  cache.entry = { at: Date.now(), result };
  return result;
}

async function runUpdateCheck(
  db: PrismaClient,
  base: UpdateCheckResult,
): Promise<UpdateCheckResult> {
  const url = getManifestUrl();
  let manifest: ChannelManifest | null;

  try {
    manifest = await fetchManifest(url);
  } catch (err: unknown) {
    Logger.warn(`[Updates] Could not read ${url}: ${String(err)}`);
    return { ...base, reason: "manifest unreachable" };
  }

  await db.instanceSettings.updateMany({
    where: { id: "default" },
    data: { lastUpdateCheckAt: new Date() },
  });

  const latestVersion = manifest?.components?.server?.version ?? null;
  if (!latestVersion) {
    return {
      ...base,
      checked: true,
      reason: "manifest carries no server version",
    };
  }

  const updateAvailable = compareVersions(latestVersion, SERVER_VERSION) > 0;

  if (!updateAvailable) {
    Logger.debug(
      `[Updates] Up to date (running ${SERVER_VERSION}, ${getUpdateChannel()} channel has ${latestVersion})`,
    );
    return { ...base, checked: true, latestVersion };
  }

  Logger.info(
    `[Updates] Server update available: ${SERVER_VERSION} -> ${latestVersion} (${getUpdateChannel()})`,
  );

  const settings = await db.instanceSettings.findUnique({
    where: { id: "default" },
    select: { lastUpdateNotifiedVersion: true },
  });

  // Only mail once per version. Re-mailing every six hours until the operator
  // upgrades would train them to ignore it.
  if (settings?.lastUpdateNotifiedVersion === latestVersion) {
    return {
      ...base,
      checked: true,
      latestVersion,
      updateAvailable: true,
      reason: "already notified for this version",
    };
  }

  if (!isEmailEnabled()) {
    return {
      ...base,
      checked: true,
      latestVersion,
      updateAvailable: true,
      reason: "email is disabled",
    };
  }

  const recipients = await resolveRecipients(db);
  if (recipients.length === 0) {
    Logger.warn(
      "[Updates] A server update is available but no recipient is configured (updates.notify-emails)",
    );
    return {
      ...base,
      checked: true,
      latestVersion,
      updateAvailable: true,
      reason: "no recipients",
    };
  }

  const server = manifest?.components?.server;

  // A pinned or air-gapped deployment can see the update but must not be told
  // to click Install: its version comes from its configuration.
  const { isBundleDeployment, readComponentState } =
    await import("./bundle-state");
  const selfUpdatable = isBundleDeployment()
    ? ((await readComponentState("app"))?.selfUpdatable ?? false)
    : false;

  let adminUrl: string | null = null;
  try {
    const externalUrl = config.get<string>("server.external-url");
    if (externalUrl) {
      adminUrl = `${externalUrl.replace(/\/$/, "")}/admin/updates`;
    }
  } catch {
    // No external URL configured; the mail still says what changed.
  }

  const template = serverUpdateAvailableEmail({
    currentVersion: SERVER_VERSION,
    latestVersion,
    channel: getUpdateChannel(),
    commit: server?.commit ?? manifest?.commit ?? null,
    adminUrl,
    selfUpdatable,
  });

  let anySent = false;
  for (const to of recipients) {
    const sent = await sendEmail({ to, ...template });
    anySent = anySent || sent;
  }

  // Only record the notification if at least one message actually went out,
  // otherwise a transient SMTP failure would suppress the alert permanently.
  if (anySent) {
    await db.instanceSettings.updateMany({
      where: { id: "default" },
      data: { lastUpdateNotifiedVersion: latestVersion },
    });
  }

  return {
    ...base,
    checked: true,
    latestVersion,
    updateAvailable: true,
    notified: anySent,
  };
}
