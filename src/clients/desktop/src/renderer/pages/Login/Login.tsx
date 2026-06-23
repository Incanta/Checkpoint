import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router";
import { nanoid } from "nanoid";
import { currentUserAtom } from "../../../common/state/auth";
import { ipc } from "../ipc";
import Spinner from "../../components/Spinner";

const ACCENT = "#646cff";

export default function Login(): React.ReactElement {
  const [daemonId] = useState(nanoid());
  const user = useAtomValue(currentUserAtom);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);
  const navigate = useNavigate();

  // Device authorization is pending once the daemon has handed us a code but
  // the user hasn't confirmed it in the browser yet.
  const awaitingAuthorization = Boolean(
    user?.auth?.code && user.details === null,
  );

  useEffect(() => {
    if (user?.details) {
      navigate("/dashboard");
    }
  }, [user, navigate]);

  const handleSignIn = (): void => {
    const endpoint = url.trim();
    if (!endpoint || submitting) {
      return;
    }
    setSubmitting(true);
    ipc.sendMessage("auth:login", { daemonId, endpoint });
  };

  const isBusy = submitting && !awaitingAuthorization;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--color-app-bg)",
        color: "var(--color-text-primary)",
      }}
    >
      <div
        style={{
          width: "22rem",
          maxWidth: "calc(100% - 2rem)",
          padding: "2rem",
          borderRadius: "0.6rem",
          border: "1px solid var(--color-border-light)",
          backgroundColor: "var(--color-panel)",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
        }}
      >
        {awaitingAuthorization ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
              gap: "1.25rem",
            }}
          >
            <Spinner size={40} />
            <div>
              <div style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                Authorize this device
              </div>
              <p
                style={{
                  margin: "0.4rem 0 0",
                  fontSize: "0.8rem",
                  lineHeight: 1.5,
                  color: "#9CA3AF",
                }}
              >
                Open the authorization page and confirm the code below to finish
                signing in.
              </p>
            </div>

            <div
              style={{
                width: "100%",
                padding: "0.85rem",
                borderRadius: "0.45rem",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "1.4rem",
                fontWeight: 600,
                letterSpacing: "0.25em",
                userSelect: "text",
              }}
            >
              {user?.auth?.code}
            </div>

            <button
              onClick={() => {
                if (user?.auth?.url) {
                  ipc.sendMessage("app:open-external", { url: user.auth.url });
                }
              }}
              style={{
                width: "100%",
                padding: "0.6rem",
                border: "none",
                borderRadius: "0.4rem",
                backgroundColor: ACCENT,
                color: "#fff",
                fontSize: "0.85rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Open authorization page
            </button>

            <div style={{ fontSize: "0.75rem", color: "#9CA3AF" }}>
              Waiting for confirmation in your browser…
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1.25rem",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                Sign in to Checkpoint
              </div>
              <p
                style={{
                  margin: "0.4rem 0 0",
                  fontSize: "0.8rem",
                  lineHeight: 1.5,
                  color: "#9CA3AF",
                }}
              >
                Connect to your Checkpoint server to get started.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <label
                htmlFor="login-server-url"
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.4rem",
                }}
              >
                Server URL
              </label>
              <input
                id="login-server-url"
                type="text"
                placeholder="http://your-server-ip:13000"
                value={url}
                disabled={isBusy}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSignIn();
                  }
                }}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.4rem",
                  border: `1px solid ${
                    focused ? ACCENT : "var(--color-border-light)"
                  }`,
                  backgroundColor: "var(--color-surface)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.85rem",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <button
              onClick={handleSignIn}
              disabled={isBusy || url.trim().length === 0}
              style={{
                width: "100%",
                padding: "0.6rem",
                border: "none",
                borderRadius: "0.4rem",
                backgroundColor: ACCENT,
                color: "#fff",
                fontSize: "0.85rem",
                fontWeight: 600,
                cursor: isBusy ? "default" : "pointer",
                opacity: isBusy || url.trim().length === 0 ? 0.6 : 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
              }}
            >
              {isBusy && <Spinner size={16} thickness={2} />}
              {isBusy ? "Connecting…" : "Sign in"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
