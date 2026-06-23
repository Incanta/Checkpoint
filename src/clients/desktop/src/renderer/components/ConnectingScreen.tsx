import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { daemonConnectionAtom } from "../../common/state/daemon";
import { ipc } from "../pages/ipc";
import Spinner from "./Spinner";

// How long to wait before suggesting the daemon may not be running.
const SLOW_CONNECT_THRESHOLD_MS = 5000;

// Docs page explaining how to start the daemon from the system tray.
// NOTE: this page does not exist yet and needs to be authored.
const DAEMON_DOCS_URL = "https://checkpointvcs.com/docs/desktop/start-daemon";

export default function ConnectingScreen(): React.ReactElement {
  const connection = useAtomValue(daemonConnectionAtom);
  const [isSlow, setIsSlow] = useState(false);

  // Only show the "is the daemon running?" hint once we've been stuck in the
  // connecting state for a while. Reset the timer if we leave that state.
  useEffect(() => {
    if (connection !== "connecting") {
      setIsSlow(false);
      return;
    }

    const timer = setTimeout(() => setIsSlow(true), SLOW_CONNECT_THRESHOLD_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [connection]);

  const isConnecting = connection === "connecting";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.5rem",
        padding: 0,
        backgroundColor: "var(--color-app-bg)",
        color: "var(--color-text-primary)",
        userSelect: "none",
      }}
    >
      <Spinner />

      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: "1.05rem",
            fontWeight: 600,
            letterSpacing: "0.01em",
          }}
        >
          {isConnecting ? "Connecting to Checkpoint" : "Getting things ready"}
        </div>
        <div
          style={{
            marginTop: "0.35rem",
            fontSize: "0.8rem",
            color: "#9CA3AF",
          }}
        >
          {isConnecting
            ? "Reaching the local Checkpoint daemon…"
            : "Loading your workspace…"}
        </div>
      </div>

      {isConnecting && isSlow && (
        <div
          style={{
            maxWidth: "26rem",
            marginTop: "0.5rem",
            padding: "1rem 1.15rem",
            borderRadius: "0.6rem",
            border: "1px solid var(--color-border-light)",
            backgroundColor: "var(--color-panel)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            animation: "cp-connecting-fade-in 0.3s ease",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: "0.85rem",
              fontWeight: 600,
              color: "var(--color-text-primary)",
            }}
          >
            This is taking longer than usual
          </div>
          <p
            style={{
              margin: "0.5rem 0 0",
              fontSize: "0.8rem",
              lineHeight: 1.5,
              color: "#B5B5B5",
            }}
          >
            Make sure the Checkpoint daemon is running. You can start it from
            the Checkpoint icon in your system tray.
          </p>
          <button
            onClick={() =>
              ipc.sendMessage("app:open-external", { url: DAEMON_DOCS_URL })
            }
            style={{
              marginTop: "0.85rem",
              backgroundColor: "transparent",
              border: "none",
              padding: 0,
              color: "#646cff",
              fontSize: "0.8rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            How to start the daemon &rarr;
          </button>
        </div>
      )}

      <style>{`
        @keyframes cp-connecting-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
