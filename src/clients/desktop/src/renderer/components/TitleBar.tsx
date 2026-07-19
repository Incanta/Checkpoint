import { useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGear } from "@fortawesome/free-solid-svg-icons/faGear";
import SettingsDialog from "./SettingsDialog";

const isMac = window.electron?.platform === "darwin";

// Space reserved for the OS window controls so our content never sits under
// them: traffic lights on the left (macOS), min/max/close on the right
// (Windows/Linux). The right value covers the three-button overlay Electron
// paints; tweak if a platform renders wider controls.
const LEFT_INSET = isMac ? 78 : 12;
const RIGHT_INSET = isMac ? 12 : 140;

interface TitleBarProps {
  /**
   * Screen-specific content shown on the left of the bar. It is draggable by
   * default; wrap any interactive elements (dropdowns, buttons) in
   * `className="app-no-drag"` so they remain clickable.
   */
  left?: ReactNode;
}

/**
 * The app's custom titlebar. It doubles as the draggable window bar and hosts
 * the settings cogwheel just left of the native window controls. Rendered at
 * the top of every screen.
 */
export default function TitleBar({ left }: TitleBarProps): React.ReactElement {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header
      className="app-drag flex h-10 shrink-0 items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]"
      style={{ paddingLeft: LEFT_INSET, paddingRight: RIGHT_INSET }}
    >
      {left && <div className="flex min-w-0 items-center gap-3">{left}</div>}
      <div className="app-no-drag ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
        >
          <FontAwesomeIcon icon={faGear} />
        </button>
      </div>
      <SettingsDialog
        visible={settingsOpen}
        onHide={() => setSettingsOpen(false)}
      />
    </header>
  );
}
