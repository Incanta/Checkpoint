import React from "react";
import { useAtom } from "jotai";
import { versionCheckAtom } from "../../common/state/version";

// Shown when the daemon's verdict against the connected server is
// `incompatible` — meaning the daemon is below the server's min_server_api.
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
    <div
      className="fixed bottom-4 left-4 z-50 max-w-sm rounded-lg border border-red-600/30 bg-[#3d2424] p-4 shadow-lg"
      style={{ minWidth: "300px" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p className="text-sm font-semibold text-red-400">Upgrade Required</p>
          <p className="mt-1 text-xs text-gray-300">{versionState.message}</p>
        </div>
      </div>
    </div>
  );
}
