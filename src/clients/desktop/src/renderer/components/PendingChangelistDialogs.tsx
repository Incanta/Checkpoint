import React, { useEffect, useRef, useState } from "react";
import { Dialog } from "primereact/dialog";
import { Button } from "./ui";
import { PendingFileTree, type Bucket } from "./StagedChangesTree";

const dialogPt = {
  root: {
    style: {
      backgroundColor: "var(--color-bg-secondary)",
      border: "1px solid var(--color-border-default)",
      borderRadius: "0.5rem",
      overflow: "hidden",
    },
  },
  header: {
    style: {
      backgroundColor: "var(--color-bg-secondary)",
      color: "var(--color-text-primary)",
      fontWeight: 600,
      borderBottom: "1px solid var(--color-border-default)",
    },
  },
  content: {
    style: {
      backgroundColor: "var(--color-bg-secondary)",
      color: "var(--color-text-secondary)",
      padding: "1.25rem 1.5rem",
    },
  },
  footer: {
    style: {
      backgroundColor: "var(--color-bg-secondary)",
      borderTop: "1px solid var(--color-border-default)",
      padding: "0.75rem",
    },
  },
};

const textareaClass =
  "box-border w-full resize-y rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none";

/** Ctrl+Enter confirms from inside a textarea, as in most commit boxes. */
function onCtrlEnter(confirm: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      confirm();
    }
  };
}

/**
 * Edits a changelist's description, or (with `branches`) creates a new
 * numbered changelist on one of them.
 */
export function ChangelistDescriptionDialog({
  visible,
  header,
  confirmLabel,
  initialDescription,
  branches,
  onConfirm,
  onHide,
}: {
  visible: boolean;
  header: string;
  confirmLabel: string;
  initialDescription: string;
  /** Offer a branch choice (creating); the first is the default. */
  branches?: string[];
  onConfirm: (description: string, branchName: string | undefined) => void;
  onHide: () => void;
}) {
  const [description, setDescription] = useState(initialDescription);
  const [branch, setBranch] = useState<string | undefined>(branches?.[0]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!visible) return;
    setDescription(initialDescription);
    setBranch(branches?.[0]);
    setTimeout(() => textareaRef.current?.focus(), 100);
    // Only on open: the props are re-created on every parent render.
  }, [visible]);

  const confirm = () => onConfirm(description.trim(), branch);

  return (
    <Dialog
      header={header}
      visible={visible}
      style={{ width: "32rem" }}
      onHide={onHide}
      pt={dialogPt}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onHide}>
            Cancel
          </Button>
          <Button onClick={confirm}>{confirmLabel}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {branches && branches.length > 1 && (
          <label className="flex flex-col gap-1.5 text-[0.85em]">
            <span>Submits to</span>
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-[0.85em]">
          <span>Description</span>
          <textarea
            ref={textareaRef}
            rows={5}
            className={textareaClass}
            value={description}
            placeholder="Describe the change..."
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={onCtrlEnter(confirm)}
          />
        </label>
      </div>
    </Dialog>
  );
}

/**
 * Confirms a submit: the description to submit with, and the files that go.
 * Folders list their contents only when expanded, as on the page itself.
 */
export function SubmitChangelistDialog({
  bucket,
  ownRows,
  submitting,
  error,
  onSubmit,
  onHide,
}: {
  /** The changelist to submit; null hides the dialog. */
  bucket: Bucket | null;
  ownRows: Set<string>;
  submitting: boolean;
  error: string | null;
  onSubmit: (description: string) => void;
  onHide: () => void;
}) {
  const [description, setDescription] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bucketId = bucket?.id ?? null;

  useEffect(() => {
    if (!bucket) return;
    setDescription(bucket.description);
    setTimeout(() => textareaRef.current?.focus(), 100);
    // Only when a different changelist opens, not on each refresh of it.
  }, [bucketId]);

  const canSubmit = !submitting && description.trim() !== "";
  const submit = () => {
    if (canSubmit) onSubmit(description.trim());
  };

  return (
    <Dialog
      header={bucket ? `Submit ${bucket.label}` : "Submit"}
      visible={bucket !== null}
      style={{ width: "40rem", maxWidth: "90vw" }}
      onHide={() => {
        if (!submitting) onHide();
      }}
      closable={!submitting}
      pt={dialogPt}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onHide} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? "Submitting..." : "Submit"}
          </Button>
        </div>
      }
    >
      {bucket && (
        <div className="flex flex-col gap-3">
          {error && (
            <p className="m-0 text-[0.85em] text-[var(--color-danger)]">
              {error}
            </p>
          )}
          <div className="text-[0.85em]">
            Submits to{" "}
            <span className="font-medium text-[var(--color-text-primary)]">
              {bucket.branchName}
            </span>
          </div>
          <label className="flex flex-col gap-1.5 text-[0.85em]">
            <span>Description</span>
            <textarea
              ref={textareaRef}
              rows={4}
              className={textareaClass}
              value={description}
              disabled={submitting}
              placeholder="Describe the change..."
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={onCtrlEnter(submit)}
            />
          </label>
          <div className="flex flex-col gap-1.5 text-[0.85em]">
            <span>
              Files{" "}
              <span className="text-[var(--color-text-muted)]">
                ({bucket.files.length})
              </span>
            </span>
            <div className="max-h-64 overflow-auto rounded border border-[var(--color-border-default)] py-1 text-[var(--color-text-primary)]">
              <PendingFileTree files={bucket.files} ownRows={ownRows} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
