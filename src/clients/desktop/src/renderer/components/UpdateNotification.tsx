import React from "react";
import { useAtom } from "jotai";
import { updateAtom } from "../../common/state/update";
import { ProgressBar } from "primereact/progressbar";
import Button from "./Button";

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

  return (
    <div
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/15 p-4 shadow-lg"
      style={{ minWidth: "300px" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          {updateState.status === "available" && (
            <>
              <p className="text-sm font-semibold text-[var(--color-accent)]">
                Update Available
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Version {updateState.latestVersion} is ready to download.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  label="Download"
                  onClick={handleDownload}
                  className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white hover:bg-[var(--color-accent-hover)]"
                />
                <Button
                  label="Later"
                  onClick={dismiss}
                  className="rounded bg-[var(--color-bg-overlay)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border-default)]"
                />
              </div>
            </>
          )}

          {updateState.status === "downloading" && (
            <>
              <p className="text-sm font-semibold text-[var(--color-accent)]">
                Downloading Update...
              </p>
              <div className="mt-2">
                <ProgressBar
                  value={updateState.downloadProgress}
                  showValue={true}
                  style={{ height: "8px" }}
                />
              </div>
            </>
          )}

          {updateState.status === "ready" && (
            <>
              <p className="text-sm font-semibold text-[var(--color-accent)]">Update Ready</p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Version {updateState.latestVersion} has been downloaded. Restart
                to apply.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  label="Restart & Update"
                  onClick={handleApply}
                  className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white hover:bg-[var(--color-accent-hover)]"
                />
                <Button
                  label="Later"
                  onClick={dismiss}
                  className="rounded bg-[var(--color-bg-overlay)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border-default)]"
                />
              </div>
            </>
          )}

          {updateState.status === "error" && (
            <>
              <p className="text-sm font-semibold text-[var(--color-danger)]">
                Update Error
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {updateState.errorMessage}
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  label="Retry"
                  onClick={handleCheck}
                  className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white hover:bg-[var(--color-accent-hover)]"
                />
                <Button
                  label="Dismiss"
                  onClick={dismiss}
                  className="rounded bg-[var(--color-bg-overlay)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border-default)]"
                />
              </div>
            </>
          )}
        </div>

        <button
          onClick={dismiss}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
