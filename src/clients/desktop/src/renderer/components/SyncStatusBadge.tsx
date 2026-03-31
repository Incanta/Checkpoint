import { useAtomValue } from "jotai";
import {
  workspaceSyncStatusAtom,
  operationProgressAtom,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";

function formatEta(
  stepStartedAt: string | null,
  done: number,
  total: number,
): string {
  if (!stepStartedAt || done <= 0 || done >= total) return "";
  const elapsed = (Date.now() - new Date(stepStartedAt).getTime()) / 1000;
  const remaining = (elapsed * (total - done)) / done;
  if (remaining < 60) return `${Math.round(remaining)}s`;
  const m = Math.floor(remaining / 60);
  const s = Math.round(remaining % 60);
  return `${m}m ${s}s`;
}

function ProgressBar() {
  const progress = useAtomValue(operationProgressAtom);
  if (!progress) return null;

  const { type, currentStep, done, total, stepStartedAt } = progress;
  const fraction = total > 0 ? Math.min(done / total, 1) : 0;
  const percent = Math.round(fraction * 100);
  const eta = formatEta(stepStartedAt, done, total);
  const label = type === "pull" ? "Pulling" : "Submitting";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.75rem",
        color: "#60A5FA",
        padding: "0 0.5rem",
        flex: 1,
        minWidth: 0,
      }}
    >
      {/* Spinner */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          flexShrink: 0,
          animation: "spin 1s linear infinite",
        }}
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>

      <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
        {label}: {currentStep || "Starting..."}
      </span>

      {total > 0 && (
        <>
          {/* Progress bar */}
          <div
            style={{
              flex: 1,
              minWidth: "60px",
              maxWidth: "180px",
              height: "6px",
              backgroundColor: "rgba(255,255,255,0.1)",
              borderRadius: "3px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${percent}%`,
                height: "100%",
                backgroundColor: "#60A5FA",
                borderRadius: "3px",
                transition: "width 0.3s ease",
              }}
            />
          </div>

          <span
            style={{ flexShrink: 0, whiteSpace: "nowrap", color: "#9CA3AF" }}
          >
            {percent}%{eta ? ` (${eta})` : ""}
          </span>
        </>
      )}

      {/* Inject keyframes for spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export default function SyncStatusBadge() {
  const syncStatus = useAtomValue(workspaceSyncStatusAtom);
  const progress = useAtomValue(operationProgressAtom);

  // Show progress bar when an operation is active
  if (progress) {
    return <ProgressBar />;
  }

  const handleRefresh = () => {
    ipc.sendMessage("workspace:sync-status:refresh", null);
  };

  const handlePreview = () => {
    ipc.sendMessage("workspace:sync-preview", null);
  };

  if (!syncStatus) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          fontSize: "0.75rem",
          color: "#6B7280",
          padding: "0 0.5rem",
        }}
      >
        <span
          style={{ cursor: "pointer" }}
          onClick={handleRefresh}
          title="Check for remote changes"
        >
          Checking sync...
        </span>
      </div>
    );
  }

  if (syncStatus.upToDate) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          fontSize: "0.75rem",
          color: "#4CAF50",
          padding: "0 0.5rem",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span
          style={{ cursor: "pointer" }}
          onClick={handleRefresh}
          title="Click to refresh"
        >
          Up to date
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        fontSize: "0.75rem",
        color: "#F59E0B",
        padding: "0 0.5rem",
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="7 13 12 18 17 13" />
        <line x1="12" y1="6" x2="12" y2="18" />
      </svg>
      <span
        style={{ cursor: "pointer" }}
        onClick={handlePreview}
        title="Click to preview incoming changes"
      >
        {syncStatus.changelistsBehind} CL
        {syncStatus.changelistsBehind !== 1 ? "s" : ""} behind
      </span>
      <button
        onClick={handleRefresh}
        title="Refresh sync status"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "0.1rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "0.15rem",
          color: "#9CA3AF",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = "#9CA3AF";
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </div>
  );
}
