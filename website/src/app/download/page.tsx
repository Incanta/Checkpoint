"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const GITHUB_REPO = "Incanta/Checkpoint";
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

type OSKey = "windows" | "macos" | "linux";

interface InstallerVariant {
  /** Stable id used for the recommended-variant lookup. */
  id: string;
  /** Short label shown on the button. */
  label: string;
  /** Matches the electron-builder artifactName for this OS/arch. */
  pattern: RegExp;
  ext: string;
}

interface PlatformConfig {
  name: string;
  Icon: (props: { className?: string }) => React.ReactElement;
  variants: InstallerVariant[];
}

// Asset filenames come from src/clients/desktop/electron-builder.json
// artifactName fields, e.g. "Checkpoint-Windows-x64-0.3.6-Setup.exe".
// The version is embedded, so we match by OS/arch + extension instead of a
// fixed name and resolve the URL from the GitHub release API at runtime.
const PLATFORMS: Record<OSKey, PlatformConfig> = {
  windows: {
    name: "Windows",
    Icon: WindowsIcon,
    variants: [
      {
        id: "win-x64",
        label: "Windows (x64)",
        pattern: /Windows-x64-.*-Setup\.exe$/i,
        ext: ".exe",
      },
    ],
  },
  macos: {
    name: "macOS",
    Icon: AppleIcon,
    variants: [
      {
        id: "mac-arm64",
        label: "Apple Silicon",
        pattern: /macOS-arm64-.*\.pkg$/i,
        ext: ".pkg",
      },
      {
        id: "mac-x64",
        label: "Intel",
        pattern: /macOS-x64-.*\.pkg$/i,
        ext: ".pkg",
      },
    ],
  },
  linux: {
    name: "Linux",
    Icon: LinuxIcon,
    variants: [
      {
        id: "linux-deb",
        label: "Debian / Ubuntu (.deb)",
        pattern: /Linux-amd64-.*\.deb$/i,
        ext: ".deb",
      },
      {
        id: "linux-rpm",
        label: "Fedora / RHEL (.rpm)",
        pattern: /Linux-amd64-.*\.rpm$/i,
        ext: ".rpm",
      },
    ],
  },
};

const OS_ORDER: OSKey[] = ["windows", "macos", "linux"];

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string;
  assets: GitHubAsset[];
}

interface Detection {
  os: OSKey | null;
  variantId: string | null;
}

/** Best-effort OS + arch detection from the browser. */
function detectPlatform(): Detection {
  if (typeof navigator === "undefined") {
    return { os: null, variantId: null };
  }

  const ua = navigator.userAgent;
  const platform = navigator.platform || "";

  // iOS / Android have no desktop installer; leave os null so the user picks.
  if (/Android/i.test(ua) || /(iPhone|iPad|iPod)/i.test(ua)) {
    return { os: null, variantId: null };
  }

  if (/Win/i.test(ua) || /Win/i.test(platform)) {
    return { os: "windows", variantId: "win-x64" };
  }

  if (/Mac/i.test(ua) || /Mac/i.test(platform)) {
    // Apple Silicon often reports as Intel (especially under Rosetta or in
    // Safari), so we can't fully trust this. Default to Apple Silicon since
    // that covers all Macs sold since 2020; Intel stays one click away.
    const arch = (
      navigator as Navigator & { userAgentData?: { architecture?: string } }
    ).userAgentData?.architecture;
    if (arch === "x86") {
      return { os: "macos", variantId: "mac-x64" };
    }
    return { os: "macos", variantId: "mac-arm64" };
  }

  if (/Linux/i.test(ua) || /Linux/i.test(platform) || /X11/i.test(ua)) {
    // Can't tell the distro from the browser; .deb covers the most users.
    return { os: "linux", variantId: "linux-deb" };
  }

  return { os: null, variantId: null };
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function triggerDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  // The asset host (github releases) responds with a Content-Disposition
  // attachment, so the browser downloads rather than navigates.
  a.click();
}

export default function DownloadPage() {
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [autoStarted, setAutoStarted] = useState(false);

  const detection = useMemo(detectPlatform, []);

  // Resolve a variant id to its matching asset in the fetched release.
  const findAsset = useCallback(
    (variantId: string): GitHubAsset | null => {
      if (!release) return null;
      for (const os of OS_ORDER) {
        const variant = PLATFORMS[os].variants.find((v) => v.id === variantId);
        if (variant) {
          return (
            release.assets.find((a) => variant.pattern.test(a.name)) ?? null
          );
        }
      }
      return null;
    },
    [release]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
          { headers: { Accept: "application/vnd.github+json" } }
        );
        if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
        const data = (await res.json()) as GitHubRelease;
        if (!cancelled) {
          setRelease(data);
          setStatus("ready");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-start the recommended download once, after the release resolves.
  useEffect(() => {
    if (status !== "ready" || autoStarted || !detection.variantId) return;
    const asset = findAsset(detection.variantId);
    if (asset) {
      setAutoStarted(true);
      triggerDownload(asset.browser_download_url);
    }
  }, [status, autoStarted, detection.variantId, findAsset]);

  const recommendedOS = detection.os;
  const version = release?.tag_name?.replace(/^v/, "") ?? null;

  return (
    <>
      <Navbar />
      <main className="flex-1 relative">
        <div className="absolute inset-0 bg-grid" />
        <div className="absolute inset-0 bg-radial-primary" />

        <section className="relative z-10 min-h-screen flex items-center justify-center py-32 px-6 lg:px-8">
          <div className="w-full max-w-4xl">
            {/* Header */}
            <div className="text-center mb-12">
              <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
                Download
              </p>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
                Get Checkpoint
              </h1>
              <p className="text-muted text-lg">
                {recommendedOS
                  ? `We detected ${PLATFORMS[recommendedOS].name}. Your download should start automatically.`
                  : "Choose your platform below to download the installer."}
                {version && (
                  <>
                    {" "}
                    <span className="text-foreground font-medium">
                      Latest version: v{version}
                    </span>
                  </>
                )}
              </p>
            </div>

            {/* Auto-download notice */}
            {status === "ready" && recommendedOS && (
              <AutoDownloadNotice
                osName={PLATFORMS[recommendedOS].name}
                onRetry={() => {
                  if (detection.variantId) {
                    const asset = findAsset(detection.variantId);
                    if (asset) triggerDownload(asset.browser_download_url);
                  }
                }}
                hasAsset={
                  !!detection.variantId && !!findAsset(detection.variantId)
                }
              />
            )}

            {/* Loading / error states */}
            {status === "loading" && (
              <div className="text-center text-muted py-12">
                <div className="inline-block w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mb-4" />
                <p>Finding the latest release…</p>
              </div>
            )}

            {status === "error" && (
              <div className="glass rounded-2xl p-8 text-center">
                <p className="text-muted mb-4">
                  We couldn&apos;t reach the GitHub release feed. You can grab
                  the installers directly from the releases page.
                </p>
                <a
                  href={RELEASES_PAGE}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex rounded-full bg-primary px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-light"
                >
                  View releases on GitHub
                </a>
              </div>
            )}

            {/* Platform cards */}
            {status === "ready" && (
              <>
                <div className="grid gap-6 md:grid-cols-3">
                  {OS_ORDER.map((os) => (
                    <PlatformCard
                      key={os}
                      config={PLATFORMS[os]}
                      recommended={os === recommendedOS}
                      recommendedVariantId={
                        os === recommendedOS ? detection.variantId : null
                      }
                      findAsset={findAsset}
                    />
                  ))}
                </div>

                <p className="text-center text-sm text-muted mt-10">
                  Looking for older versions or checksums?{" "}
                  <a
                    href={RELEASES_PAGE}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-light hover:underline"
                  >
                    Browse all releases on GitHub
                  </a>
                  .
                </p>
              </>
            )}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function AutoDownloadNotice({
  osName,
  hasAsset,
  onRetry,
}: {
  osName: string;
  hasAsset: boolean;
  onRetry: () => void;
}) {
  if (!hasAsset) {
    return (
      <div className="glass rounded-2xl p-5 mb-10 text-center text-sm text-muted">
        No {osName} installer was found in the latest release. Pick another
        option below.
      </div>
    );
  }

  return (
    <div className="glass-primary rounded-2xl p-5 mb-10 text-center">
      <p className="text-sm text-foreground">
        Download not starting?{" "}
        <button
          onClick={onRetry}
          className="text-primary-light font-medium hover:underline"
        >
          Click here to download for {osName}
        </button>
        .
      </p>
    </div>
  );
}

function PlatformCard({
  config,
  recommended,
  recommendedVariantId,
  findAsset,
}: {
  config: PlatformConfig;
  recommended: boolean;
  recommendedVariantId: string | null;
  findAsset: (variantId: string) => GitHubAsset | null;
}) {
  const { Icon } = config;

  return (
    <div
      className={`relative rounded-2xl p-6 flex flex-col ${
        recommended ? "glass-primary glow-primary" : "glass"
      }`}
    >
      {recommended && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white">
          Recommended
        </span>
      )}

      <div className="flex items-center gap-3 mb-5">
        <Icon className="w-8 h-8 text-foreground" />
        <h2 className="text-xl font-semibold">{config.name}</h2>
      </div>

      <div className="flex flex-col gap-3 mt-auto">
        {config.variants.map((variant) => {
          const asset = findAsset(variant.id);
          const isPrimary = variant.id === recommendedVariantId;
          return (
            <DownloadButton
              key={variant.id}
              label={variant.label}
              asset={asset}
              primary={isPrimary}
            />
          );
        })}
      </div>
    </div>
  );
}

function DownloadButton({
  label,
  asset,
  primary,
}: {
  label: string;
  asset: GitHubAsset | null;
  primary: boolean;
}) {
  if (!asset) {
    return (
      <span className="rounded-full glass px-5 py-2.5 text-sm text-muted/60 text-center cursor-not-allowed">
        {label} (unavailable)
      </span>
    );
  }

  return (
    <a
      href={asset.browser_download_url}
      className={`flex items-center justify-between gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-all ${
        primary
          ? "bg-primary text-white hover:bg-primary-light hover:shadow-lg hover:shadow-primary/25"
          : "glass text-foreground hover:bg-surface-hover"
      }`}
    >
      <span className="flex items-center gap-2">
        <DownloadIcon className="w-4 h-4" />
        {label}
      </span>
      {asset.size > 0 && (
        <span
          className={`text-xs ${primary ? "text-white/70" : "text-muted"}`}
        >
          {formatSize(asset.size)}
        </span>
      )}
    </a>
  );
}

/* ---- Icons ---- */

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"
      />
    </svg>
  );
}

function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 5.48l7.5-1.02v7.23H3V5.48zM3 18.52l7.5 1.02v-7.14H3v6.12zM11.4 4.33L21 3v8.69h-9.6V4.33zM11.4 19.67L21 21v-8.6h-9.6v7.27z" />
    </svg>
  );
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.05 12.04c-.03-2.66 2.17-3.93 2.27-4-1.24-1.81-3.16-2.06-3.84-2.09-1.63-.17-3.19.96-4.02.96-.83 0-2.11-.94-3.47-.91-1.78.03-3.43 1.04-4.35 2.63-1.86 3.22-.47 7.98 1.33 10.59.88 1.28 1.93 2.71 3.31 2.66 1.33-.05 1.83-.86 3.44-.86 1.61 0 2.06.86 3.47.83 1.43-.03 2.34-1.3 3.21-2.59 1.01-1.48 1.43-2.92 1.45-2.99-.03-.01-2.78-1.07-2.81-4.23M14.53 4.32c.73-.89 1.22-2.12 1.09-3.35-1.05.04-2.33.7-3.08 1.58-.67.78-1.26 2.03-1.1 3.23 1.17.09 2.36-.59 3.09-1.46" />
    </svg>
  );
}

function LinuxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.5 2c-1.7 0-3 1.5-3 3.4 0 .5.1 1 .1 1.5-.3.7-1.1 1.7-1.8 2.9-.9 1.5-1.7 3.2-1.9 4.4-.2 1.1-.6 1.9-1.1 2.7-.3.5-.5 1-.4 1.5.1.4.5.7 1 .8.4.1.6.4.6.8 0 .5.4.9 1.1 1 .6.1 1.4 0 2.1-.3.4-.2.8-.2 1.2 0 .7.3 1.5.4 2.1.3.7-.1 1.1-.5 1.1-1 0-.4.2-.7.6-.8.5-.1.9-.4 1-.8.1-.5-.1-1-.4-1.5-.5-.8-.9-1.6-1.1-2.7-.2-1.2-1-2.9-1.9-4.4-.7-1.2-1.5-2.2-1.8-2.9 0-.5.1-1 .1-1.5C15.5 3.5 14.2 2 12.5 2m-.9 3.1c.3 0 .6.4.6.9s-.3.9-.6.9-.6-.4-.6-.9.3-.9.6-.9m1.9 0c.3 0 .6.4.6.9s-.3.9-.6.9-.6-.4-.6-.9.3-.9.6-.9" />
    </svg>
  );
}
