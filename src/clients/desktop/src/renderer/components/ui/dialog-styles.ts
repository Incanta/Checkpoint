// Field styles shared by the app's dialogs (see dialog.tsx), so inputs line
// up the same way everywhere.

/** A single-line text or number field inside a dialog. */
export const dialogInputClass =
  "box-border w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60";

/** A native select inside a dialog, matching `dialogInputClass`. */
export const dialogSelectClass =
  "box-border w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none";

/** A labelled field: a small caption above its input. */
export const dialogFieldClass = "flex flex-col gap-1.5 text-[0.85em]";
