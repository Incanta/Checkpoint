import { useState, useEffect, useRef } from "react";
import { Button, Dialog, dialogFieldClass, dialogInputClass } from "./ui";
import { ipc } from "../pages/ipc";

interface CreateLabelDialogProps {
  visible: boolean;
  changelistNumber: number | null;
  onHide: () => void;
}

export default function CreateLabelDialog({
  visible,
  changelistNumber,
  onHide,
}: CreateLabelDialogProps) {
  const [name, setName] = useState("");
  const [clNumber, setClNumber] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setName("");
      setClNumber(changelistNumber !== null ? String(changelistNumber) : "");
      setError(null);
      setIsPending(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible, changelistNumber]);

  useEffect(() => {
    if (!visible) return;

    const unsubSuccess = ipc.on("workspace:create-label:success", () => {
      setIsPending(false);
      onHide();
    });

    const unsubError = ipc.on("workspace:create-label:error", (data) => {
      setIsPending(false);
      setError(data.message);
    });

    return () => {
      unsubSuccess();
      unsubError();
    };
  }, [visible, onHide]);

  const resolvedCl =
    changelistNumber !== null ? changelistNumber : parseInt(clNumber, 10);
  const isClValid = !isNaN(resolvedCl) && resolvedCl >= 0;

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed || !isClValid) return;

    setIsPending(true);
    setError(null);
    ipc.sendMessage("workspace:create-label", {
      changelistNumber: resolvedCl,
      name: trimmed,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && name.trim() && isClValid) {
      handleSubmit();
    }
  };

  return (
    <Dialog
      header="Create Label"
      visible={visible}
      style={{ width: "26rem" }}
      onHide={onHide}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onHide} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !name.trim() || !isClValid}
          >
            {isPending ? "Creating..." : "Create"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p className="m-0 text-[0.85em] text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <label className={dialogFieldClass}>
          <span>Changelist number</span>
          {changelistNumber !== null ? (
            <input
              className={dialogInputClass}
              value={String(changelistNumber)}
              disabled
            />
          ) : (
            <input
              className={dialogInputClass}
              value={clNumber}
              onChange={(e) => setClNumber(e.target.value.replace(/\D/g, ""))}
              onKeyDown={handleKeyDown}
              placeholder="e.g. 42"
              inputMode="numeric"
              disabled={isPending}
            />
          )}
        </label>
        <label className={dialogFieldClass}>
          <span>Label name</span>
          <input
            ref={inputRef}
            className={dialogInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. v1.0.0"
            disabled={isPending}
          />
        </label>
      </div>
    </Dialog>
  );
}
