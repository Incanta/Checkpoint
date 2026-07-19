import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useLocation, useNavigate } from "react-router";
import { nanoid } from "nanoid";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons/faArrowLeft";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { currentUserAtom } from "../../../common/state/auth";
import { ipc } from "../ipc";
import Spinner from "../../components/Spinner";
import TitleBar from "../../components/TitleBar";
import { Button } from "../../components/ui";

export default function Login(): React.ReactElement {
  const [daemonId] = useState(nanoid());
  const user = useAtomValue(currentUserAtom);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromDashboard =
    (location.state as { from?: string } | null)?.from === "dashboard";

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
    <div className="flex h-full w-full flex-col bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      <TitleBar />
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-[22rem] max-w-[calc(100%-2rem)] rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-8 shadow-lg">
        {cameFromDashboard && (
          <button
            onClick={() => navigate("/dashboard")}
            className="mb-5 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <FontAwesomeIcon icon={faArrowLeft} />
            Back
          </button>
        )}
        {awaitingAuthorization ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <Spinner size={40} />
            <div>
              <div className="text-base font-semibold">
                Authorize this device
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                Open the authorization page and confirm the code below to finish
                signing in.
              </p>
            </div>

            <div className="w-full select-text rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3.5 font-mono text-2xl font-semibold tracking-[0.25em]">
              {user?.auth?.code}
            </div>

            <Button
              className="w-full"
              onClick={() => {
                if (user?.auth?.url) {
                  ipc.sendMessage("app:open-external", { url: user.auth.url });
                }
              }}
            >
              Open authorization page
            </Button>

            <div className="text-xs text-[var(--color-text-muted)]">
              Waiting for confirmation in your browser…
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="text-center">
              <div className="text-lg font-semibold">Sign in to Checkpoint</div>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                Connect to your Checkpoint server to get started.
              </p>
            </div>

            <div className="flex flex-col">
              <label
                htmlFor="login-server-url"
                className="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]"
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSignIn();
                  }
                }}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
              />
            </div>

            <Button
              className="w-full"
              onClick={handleSignIn}
              disabled={isBusy || url.trim().length === 0}
            >
              {isBusy && <Spinner size={16} thickness={2} />}
              {isBusy ? "Connecting…" : "Sign in"}
            </Button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
