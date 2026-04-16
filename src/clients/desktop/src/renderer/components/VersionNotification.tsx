import React from "react";
import { useAtom } from "jotai";
import { versionCheckAtom } from "../../common/state/version";
import Button from "./Button";

export default function VersionNotification(): React.ReactElement | null {
  const [versionState, setVersionState] = useAtom(versionCheckAtom);

  if (
    !versionState ||
    versionState.dismissed ||
    versionState.status === "compatible" ||
    versionState.status === "unknown"
  ) {
    return null;
  }

  const dismiss = (): void => {
    if (versionState.status === "warning") {
      setVersionState({ ...versionState, dismissed: true });
      window.electron.ipcRenderer.sendMessage("version:dismiss", null);
    }
  };

  const isIncompatible = versionState.status === "incompatible";

  return (
    <div
      className={`fixed bottom-4 left-4 z-50 max-w-sm rounded-lg border p-4 shadow-lg ${
        isIncompatible
          ? "border-red-600/30 bg-[#3d2424]"
          : "border-yellow-600/30 bg-[#3d3524]"
      }`}
      style={{ minWidth: "300px" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p
            className={`text-sm font-semibold ${
              isIncompatible ? "text-red-400" : "text-yellow-400"
            }`}
          >
            {isIncompatible ? "Upgrade Required" : "Upgrade Recommended"}
          </p>
          <p className="mt-1 text-xs text-gray-300">{versionState.message}</p>
          <div className="mt-3 flex gap-2">
            {!isIncompatible && (
              <Button
                label="Dismiss"
                onClick={dismiss}
                className="rounded bg-gray-600 px-3 py-1 text-xs text-white hover:bg-gray-700"
              />
            )}
          </div>
        </div>

        {!isIncompatible && (
          <button
            onClick={dismiss}
            className="text-gray-400 hover:text-white"
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
