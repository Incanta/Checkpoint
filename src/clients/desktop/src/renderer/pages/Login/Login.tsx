import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router";
import { nanoid } from "nanoid";
import { currentUserAtom, pendingLoginAtom } from "../../../common/state/auth";
import { ipc } from "../ipc";
import Spinner from "../../components/Spinner";
import TitleBar from "../../components/TitleBar";
import { Button } from "../../components/ui";

// First-run sign-in. Once there's an account, more are added from the
// dashboard's Manage Accounts dialog instead.
export default function Login(): React.ReactElement {
  const [daemonId, setDaemonId] = useState(nanoid());
  const user = useAtomValue(currentUserAtom);
  const pendingLoginValue = useAtomValue(pendingLoginAtom);
  const pendingLogin =
    pendingLoginValue?.daemonId === daemonId ? pendingLoginValue : null;
  const [url, setUrl] = useState("");
  const navigate = useNavigate();

  // Device authorization is pending once the daemon has handed us a code but
  // the user hasn't confirmed it in the browser yet.
  const awaitingAuthorization = Boolean(
    pendingLogin?.code && !pendingLogin.error,
  );
  const error = pendingLogin?.error ?? null;

  useEffect(() => {
    if (user?.details) {
      navigate("/dashboard");
    }
  }, [user, navigate]);

  const handleSignIn = (): void => {
    const endpoint = url.trim();
    if (!endpoint || (pendingLogin && !error)) {
      return;
    }
    // A failed attempt is finished; retry under a fresh id.
    const id = error ? nanoid() : daemonId;
    setDaemonId(id);
    ipc.sendMessage("auth:login", { daemonId: id, endpoint });
  };

  const handleCancel = (): void => {
    ipc.sendMessage("auth:login:cancel", { daemonId });
  };

  const isBusy = pendingLogin !== null && !awaitingAuthorization && !error;

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      <TitleBar />
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="box-border w-[26rem] max-w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-8 shadow-lg">
          {awaitingAuthorization ? (
            <div className="flex flex-col items-center gap-5 text-center">
              <Spinner size={40} />
              <div>
                <div className="text-base font-semibold">
                  Authorize this device
                </div>
                <p className="mt-1.5 mb-0 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                  Open the authorization page and confirm the code below to
                  finish signing in.
                </p>
              </div>

              <div className="box-border w-full select-text rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3.5 font-mono text-2xl font-semibold tracking-[0.25em]">
                {pendingLogin?.code}
              </div>

              <Button
                className="box-border w-full"
                onClick={() => {
                  if (pendingLogin?.url) {
                    ipc.sendMessage("app:open-external", {
                      url: pendingLogin.url,
                    });
                  }
                }}
              >
                Open authorization page
              </Button>

              <div className="text-xs text-[var(--color-text-muted)]">
                Waiting for confirmation in your browser…
              </div>

              <button
                onClick={handleCancel}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="text-center">
                <div className="text-lg font-semibold">
                  Sign in to Checkpoint
                </div>
                <p className="mt-1.5 mb-0 text-sm leading-relaxed text-[var(--color-text-secondary)]">
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
                  className="box-border w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
                />
              </div>

              {error && (
                <p className="m-0 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs leading-relaxed text-[var(--color-danger)]">
                  {error}
                </p>
              )}

              <Button
                className="box-border w-full"
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
