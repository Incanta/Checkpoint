import React from "react";
import { useAtom } from "jotai";
import { updateAtom } from "../../common/state/update";
import { Button } from "./ui";

function DismissButton({
  onClick,
}: {
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dismiss"
      // The app's base <button> style paints a filled pill; a toast's close
      // affordance should read as part of the panel, so the chrome is cleared
      // and only comes back as a faint wash on hover.
      className="-mt-1 -mr-1 shrink-0 cursor-pointer rounded-md border-transparent bg-transparent p-1 leading-none text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-text-primary)]/10 hover:text-[var(--color-text-primary)]"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
        className="block"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

export default function UpdateNotification(): React.ReactElement | null {
  const [updateState, setUpdateState] = useAtom(updateAtom);

  if (
    !updateState ||
    updateState.dismissed ||
    updateState.status === "idle" ||
    updateState.status === "checking"
  ) {
    return null;
  }

  const dismiss = (): void => {
    setUpdateState({ ...updateState, dismissed: true });
  };

  const handleCheck = (): void => {
    window.electron.ipcRenderer.sendMessage("update:check", null);
  };

  const handleDownload = (): void => {
    window.electron.ipcRenderer.sendMessage("update:download", null);
  };

  const handleApply = (): void => {
    window.electron.ipcRenderer.sendMessage("update:apply", null);
  };

  const percent = Math.max(
    0,
    Math.min(100, Math.round(updateState.downloadProgress ?? 0)),
  );

  const isError = updateState.status === "error";
  const tint = isError ? "var(--color-danger)" : "var(--color-accent)";

  const title = {
    available: "Update Available",
    downloading: "Downloading Update",
    ready: "Update Ready",
    error: "Update Error",
  }[updateState.status];

  return (
    <div
      className="fixed right-4 bottom-4 z-50 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border p-4 shadow-lg"
      style={{
        // Opaque: the accent tint is mixed into the panel color rather than
        // laid over it with alpha, so page content never shows through.
        backgroundColor: `color-mix(in srgb, ${tint} 15%, var(--color-bg-secondary))`,
        borderColor: `color-mix(in srgb, ${tint} 30%, var(--color-bg-secondary))`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold" style={{ color: tint }}>
          {title}
        </p>
        <DismissButton onClick={dismiss} />
      </div>

      {updateState.status === "available" && (
        <>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Version {updateState.latestVersion} is ready to download.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={handleDownload}>
              Download
            </Button>
            <Button variant="secondary" size="sm" onClick={dismiss}>
              Later
            </Button>
          </div>
        </>
      )}

      {updateState.status === "downloading" && (
        <div className="mt-2">
          <div className="flex items-baseline justify-between gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="truncate">
              {updateState.latestVersion
                ? `Version ${updateState.latestVersion}`
                : "Fetching update"}
            </span>
            {/* The percentage sits above the track rather than inside it, so a
                thin bar can't clip the label. */}
            <span className="shrink-0 tabular-nums">{percent}%</span>
          </div>
          <div
            className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: "var(--color-bg-surface)" }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-out"
              style={{
                width: `${percent}%`,
                backgroundColor: "var(--color-accent)",
              }}
            />
          </div>
        </div>
      )}

      {updateState.status === "ready" && (
        <>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Version {updateState.latestVersion} has been downloaded. Restart to
            apply.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={handleApply}>
              Restart &amp; Update
            </Button>
            <Button variant="secondary" size="sm" onClick={dismiss}>
              Later
            </Button>
          </div>
        </>
      )}

      {updateState.status === "error" && (
        <>
          <p className="mt-1 text-xs break-words text-[var(--color-text-secondary)]">
            {updateState.errorMessage}
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={handleCheck}>
              Retry
            </Button>
            <Button variant="secondary" size="sm" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
