import { useAtomValue } from "jotai";
import { workspaceSyncStatusAtom } from "../../common/state/workspace";
import { ipc } from "../pages/ipc";

export default function SyncStatusBadge() {
  const syncStatus = useAtomValue(workspaceSyncStatusAtom);

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
