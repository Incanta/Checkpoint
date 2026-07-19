import React, { useState } from "react";
import { useAtomValue } from "jotai";
import { serverReachableAtom } from "../../common/state/daemon";
import { currentUserAtom } from "../../common/state/auth";
import { ipc } from "../pages/ipc";

// Shown when the local daemon is up but the account's remote Checkpoint server
// couldn't be reached. The app still opens using cached data (dashboard /
// last workspace); this warns that server-backed actions (pull, submit, etc.)
// won't work until the connection is restored. Hidden on the sign-in page,
// where there's no account context.
export default function ServerStatusBanner(): React.ReactElement | null {
  const reachable = useAtomValue(serverReachableAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const [retrying, setRetrying] = useState(false);

  if (reachable || !currentUser) {
    return null;
  }

  const handleRetry = (): void => {
    setRetrying(true);
    ipc.sendMessage("auth:recheck", null);
    // The banner disappears on its own once the recheck reports the server as
    // reachable again; re-enable the button after a moment if it doesn't.
    setTimeout(() => setRetrying(false), 3000);
  };

  return (
    <div
      className="fixed top-14 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/15 px-4 py-2 shadow-lg"
      style={{ minWidth: "320px" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-semibold text-[var(--color-warning)]">
            Server unreachable
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
            Showing your last-known data. Pulling, submitting, and other server
            actions won&apos;t work until the connection is restored.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className="shrink-0 rounded border border-[var(--color-warning)]/40 px-2 py-1 text-xs text-[var(--color-warning)] hover:bg-[var(--color-warning)]/10 disabled:opacity-50"
        >
          {retrying ? "Retrying..." : "Retry"}
        </button>
      </div>
    </div>
  );
}
