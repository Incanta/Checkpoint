import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "primereact/dialog";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMinus } from "@fortawesome/free-solid-svg-icons/faMinus";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import { ipc } from "../pages/ipc";
import { useTheme, type Theme } from "../theme";
import { Button } from "./ui";

const DOCS_URL = "https://checkpointvcs.com/docs";
const ISSUES_URL = "https://github.com/Incanta/Checkpoint/issues";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

// PrimeReact ships no base theme here, so the Dialog gets its padding, borders,
// and close button from these passthrough classes.
const dialogPt = {
  root: {
    className:
      "rounded-lg border border-[var(--color-border-default)] shadow-xl overflow-hidden",
  },
  header: {
    className:
      "flex items-center justify-between gap-4 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-5 py-3.5 text-base font-semibold text-[var(--color-text-primary)]",
  },
  content: {
    className: "bg-[var(--color-bg-secondary)] p-0 text-[var(--color-text-secondary)]",
  },
  footer: {
    className:
      "border-t border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-5 py-3.5",
  },
  closeButton: {
    className:
      "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]",
  },
};

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div className="px-5 py-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-[var(--color-text-primary)]">{label}</div>
        {hint && (
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ThemeSegmented({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (theme: Theme) => void;
}): React.ReactElement {
  const options: { value: Theme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <div className="inline-flex rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded border-0 px-3 py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? "bg-[var(--color-accent)] text-white"
              : "bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? "bg-[var(--color-accent)]"
          : "bg-[var(--color-bg-overlay)]"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function ZoomStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (factor: number) => void;
}): React.ReactElement {
  const btn =
    "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        className={btn}
        disabled={value <= MIN_ZOOM}
        onClick={() => onChange(value - 0.1)}
        title="Zoom out"
      >
        <FontAwesomeIcon icon={faMinus} className="text-xs" />
      </button>
      <button
        type="button"
        onClick={() => onChange(1)}
        title="Reset to 100%"
        className="min-w-[3rem] cursor-pointer border-0 bg-transparent text-center text-sm text-[var(--color-text-primary)]"
      >
        {Math.round(value * 100)}%
      </button>
      <button
        type="button"
        className={btn}
        disabled={value >= MAX_ZOOM}
        onClick={() => onChange(value + 0.1)}
        title="Zoom in"
      >
        <FontAwesomeIcon icon={faPlus} className="text-xs" />
      </button>
    </div>
  );
}

interface SettingsDialogProps {
  visible: boolean;
  onHide: () => void;
}

export default function SettingsDialog({
  visible,
  onHide,
}: SettingsDialogProps): React.ReactElement {
  const { theme, setTheme } = useTheme();
  const [mcp, setMcp] = useState<{
    enabled: boolean;
    available: boolean;
  } | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [appInfo, setAppInfo] = useState<{
    appVersion: string;
    electron: string;
    chrome: string;
  } | null>(null);

  // Load current values each time the dialog opens.
  useEffect(() => {
    if (!visible) return;
    ipc
      .invoke("settings:mcp:get-status", null)
      .then(setMcp)
      .catch(() => setMcp({ enabled: false, available: false }));
    ipc
      .invoke("settings:zoom:get", null)
      .then((r) => setZoom(r.factor))
      .catch(() => {});
    ipc
      .invoke("settings:get-app-info", null)
      .then(setAppInfo)
      .catch(() => {});
  }, [visible]);

  const toggleMcp = async (): Promise<void> => {
    if (!mcp?.available || mcpBusy) return;
    setMcpBusy(true);
    try {
      const next = await ipc.invoke("settings:mcp:set-enabled", {
        enabled: !mcp.enabled,
      });
      setMcp(next);
    } finally {
      setMcpBusy(false);
    }
  };

  const changeZoom = async (factor: number): Promise<void> => {
    const clamped =
      Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor)) * 100) / 100;
    setZoom(clamped);
    try {
      const r = await ipc.invoke("settings:zoom:set", { factor: clamped });
      setZoom(r.factor);
    } catch {
      // Leave the optimistic value in place if the main process is unavailable.
    }
  };

  return (
    <Dialog
      header="Settings"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: "32rem" }}
      pt={dialogPt}
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onHide}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col divide-y divide-[var(--color-border-muted)]">
        <Section title="Appearance">
          <Row label="Theme">
            <ThemeSegmented value={theme} onChange={setTheme} />
          </Row>
        </Section>

        <Section title="Daemon">
          <Row
            label="MCP server"
            hint={
              mcp && !mcp.available
                ? "Daemon unavailable"
                : "Expose Checkpoint tools to AI agents"
            }
          >
            <Switch
              checked={!!mcp?.enabled}
              disabled={!mcp?.available || mcpBusy}
              onChange={toggleMcp}
            />
          </Row>
        </Section>

        <Section title="Display">
          <Row label="Zoom">
            <ZoomStepper value={zoom} onChange={changeZoom} />
          </Row>
        </Section>

        <Section title="About">
          <Row label="Version">
            <span className="text-sm text-[var(--color-text-primary)]">
              {appInfo?.appVersion ?? "…"}
            </span>
          </Row>
          {appInfo && (
            <Row label="Runtime">
              <span className="text-xs text-[var(--color-text-muted)]">
                Electron {appInfo.electron} · Chromium {appInfo.chrome}
              </span>
            </Row>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => ipc.sendMessage("update:check", null)}
            >
              Check for updates
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                ipc.sendMessage("app:open-external", { url: DOCS_URL })
              }
            >
              Documentation
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                ipc.sendMessage("app:open-external", { url: ISSUES_URL })
              }
            >
              Report an issue
            </Button>
          </div>
        </Section>
      </div>
    </Dialog>
  );
}
