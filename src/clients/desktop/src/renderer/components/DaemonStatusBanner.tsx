import React from "react";
import { useAtomValue } from "jotai";
import { daemonConnectionAtom } from "../../common/state/daemon";

// Shown when the app had a daemon connection and lost it (a crash, or the
// daemon stopped from the tray). The main process is already relaunching the
// tray and retrying, so this only explains why actions aren't working; it
// disappears on its own once the daemon answers again. Startup uses the full
// connecting screen instead (see Loading).
export default function DaemonStatusBanner(): React.ReactElement | null {
  const connection = useAtomValue(daemonConnectionAtom);

  if (connection !== "reconnecting") {
    return null;
  }

  return (
    <div
      className="fixed top-14 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 shadow-lg"
      style={{
        minWidth: "320px",
        // Opaque: the warning tint is mixed into the panel color rather than
        // laid over it with alpha, so page content never shows through.
        backgroundColor:
          "color-mix(in srgb, var(--color-warning) 15%, var(--color-bg-secondary))",
        borderColor:
          "color-mix(in srgb, var(--color-warning) 30%, var(--color-bg-secondary))",
      }}
    >
      <p className="text-sm font-semibold text-[var(--color-warning)]">
        Reconnecting to Checkpoint…
      </p>
      <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
        The local Checkpoint daemon stopped responding. It&apos;s being
        restarted; if it was stopped on purpose, start it from the tray icon.
      </p>
    </div>
  );
}
