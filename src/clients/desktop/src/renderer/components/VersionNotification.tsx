import React from "react";
import { useAtom } from "jotai";
import { versionCheckAtom } from "../../common/state/version";

// Shown when the daemon's verdict against the connected server is
// `incompatible` (meaning the daemon is below the server's min_server_api).
// With the new model there's no soft "warning" state to dismiss: either the
// daemon is too old (and gets hard-blocked by the daemon's own middleware) or
// it isn't.
export default function VersionNotification(): React.ReactElement | null {
  const [versionState] = useAtom(versionCheckAtom);

  if (
    !versionState ||
    versionState.status === "compatible" ||
    versionState.status === "unknown"
  ) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 top-10 z-50 border-b border-[var(--color-danger)]/30 bg-[var(--color-danger)]/15 px-6 py-2.5 shadow-sm backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center">
        <span className="text-sm font-semibold text-[var(--color-danger)]">
          Upgrade Required
        </span>
        <span className="text-xs text-[var(--color-text-secondary)]">
          {versionState.message}
        </span>
      </div>
    </div>
  );
}
