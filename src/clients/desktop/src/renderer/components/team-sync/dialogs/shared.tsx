import { type ReactNode } from "react";

// Shared PrimeReact Dialog passthrough styling for the Team Sync dialogs, kept
// consistent with SettingsDialog. Content padding is left to each dialog so
// tabbed layouts can manage their own gutters.
export const teamSyncDialogPt = {
  root: {
    className:
      "rounded-lg border border-[var(--color-border-default)] shadow-xl overflow-hidden",
  },
  header: {
    className:
      "flex items-center justify-between gap-4 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-5 py-3.5 text-base font-semibold text-[var(--color-text-primary)]",
  },
  content: {
    className:
      "bg-[var(--color-bg-secondary)] p-0 text-[var(--color-text-secondary)]",
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

/** Shared textarea styling for the newline-separated rule editors. */
export const textareaClass =
  "w-full resize-y rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 font-mono text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]";

/** Shared select styling to match the surrounding controls. */
export const selectClass =
  "rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]";

export function Switch({
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
        checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-bg-overlay)]"
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

export function CheckRow({
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  hint?: ReactNode;
  onChange: () => void;
}): React.ReactElement {
  return (
    <label
      className={`flex items-start gap-2.5 ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-[var(--color-text-primary)]">
          {label}
        </span>
        {hint && (
          <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

export function FieldRow({
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

/** Human-readable byte size, e.g. "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
