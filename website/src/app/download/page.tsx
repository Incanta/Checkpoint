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

// Self-contained, daemonless CLI packages (CLI + bundled daemon). Asset names
// come from scripts/assemble-cli-package.sh (portable archives) and
// installer/nfpm-cli.yaml (Linux deb/rpm), built by the package-cli job in
// .github/workflows/build-installers.yaml. Portable archive names have no
// embedded version (e.g. "checkpoint-cli-linux-x64.tar.gz"); the deb/rpm use
// nfpm's default naming ("checkpoint-cli_<ver>_amd64.deb",
// "checkpoint-cli-<ver>.x86_64.rpm").
const CLI_PLATFORMS: Record<OSKey, PlatformConfig> = {
  windows: {
    name: "Windows",
    Icon: WindowsIcon,
    variants: [
      {
        id: "cli-win-x64",
        label: "Portable (x64, .zip)",
        pattern: /checkpoint-cli-win32-x64\.zip$/i,
        ext: ".zip",
      },
    ],
  },
  macos: {
    name: "macOS",
    Icon: AppleIcon,
    variants: [
      {
        id: "cli-mac-arm64",
        label: "Portable (Apple Silicon, .tar.gz)",
        pattern: /checkpoint-cli-darwin-arm64\.tar\.gz$/i,
        ext: ".tar.gz",
      },
      {
        id: "cli-mac-x64",
        label: "Portable (Intel, .tar.gz)",
        pattern: /checkpoint-cli-darwin-x64\.tar\.gz$/i,
        ext: ".tar.gz",
      },
    ],
  },
  linux: {
    name: "Linux",
    Icon: LinuxIcon,
    variants: [
      {
        id: "cli-linux-x64",
        label: "Portable (x64, .tar.gz)",
        pattern: /checkpoint-cli-linux-x64\.tar\.gz$/i,
        ext: ".tar.gz",
      },
      {
        id: "cli-linux-deb",
        label: "Debian / Ubuntu installer (.deb)",
        pattern: /checkpoint-cli[-_].*amd64\.deb$/i,
        ext: ".deb",
      },
      {
        id: "cli-linux-rpm",
        label: "Fedora / RHEL installer (.rpm)",
        pattern: /checkpoint-cli[-_].*\.rpm$/i,
        ext: ".rpm",
      },
    ],
  },
};

const OS_ORDER: OSKey[] = ["windows", "macos", "linux"];

/** Look up a variant by id across both the desktop and CLI platform tables. */
function findVariant(variantId: string): InstallerVariant | null {
  for (const os of OS_ORDER) {
    const variant =
      PLATFORMS[os].variants.find((v) => v.id === variantId) ??
      CLI_PLATFORMS[os].variants.find((v) => v.id === variantId);
    if (variant) return variant;
  }
  return null;
}

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
    "loading",
  );
  const [autoStarted, setAutoStarted] = useState(false);

  const detection = useMemo(detectPlatform, []);

  // Resolve a variant id to its matching asset in the fetched release.
  const findAsset = useCallback(
    (variantId: string): GitHubAsset | null => {
      if (!release) return null;
      const variant = findVariant(variantId);
      if (!variant) return null;
      return release.assets.find((a) => variant.pattern.test(a.name)) ?? null;
    },
    [release],
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
          { headers: { Accept: "application/vnd.github+json" } },
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

                {/* Command-line tools */}
                <div className="mt-16">
                  <div className="text-center mb-8">
                    <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3">
                      Command-line tools
                    </h2>
                    <p className="text-muted max-w-2xl mx-auto">
                      Headless, self-contained packages with just the{" "}
                      <code className="text-foreground">chk</code> CLI and a
                      bundled daemon, no desktop app required. Portable archives
                      run anywhere once extracted; the Linux installers put{" "}
                      <code className="text-foreground">chk</code> on your PATH.
                      The daemon is not enabled as a service and will be
                      ephemeral by default.
                    </p>
                  </div>

                  <div className="grid gap-6 md:grid-cols-3">
                    {OS_ORDER.map((os) => (
                      <PlatformCard
                        key={os}
                        config={CLI_PLATFORMS[os]}
                        recommended={false}
                        recommendedVariantId={null}
                        findAsset={findAsset}
                      />
                    ))}
                  </div>
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
        <span className={`text-xs ${primary ? "text-white/70" : "text-muted"}`}>
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
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z" />
    </svg>
  );
}
