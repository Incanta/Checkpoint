// PrimeReact ships no base theme here, so a Dialog gets its padding, borders,
// and close button from these passthrough classes. Every app dialog should use
// them so headers, close buttons, and fields line up the same way.
export const dialogPt = {
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
      "bg-[var(--color-bg-secondary)] px-5 py-4 text-[var(--color-text-secondary)]",
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

/** A single-line text or number field inside a dialog. */
export const dialogInputClass =
  "box-border w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60";

/** A native select inside a dialog, matching `dialogInputClass`. */
export const dialogSelectClass =
  "box-border w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none";

/** A labelled field: a small caption above its input. */
export const dialogFieldClass = "flex flex-col gap-1.5 text-[0.85em]";
