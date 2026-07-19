import { useState, useEffect, useRef } from "react";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { Button } from "./ui";
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
        padding: "1.5rem",
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

  const inputStyle = {
    backgroundColor: "var(--color-bg-surface)",
    color: "var(--color-text-primary)",
    border: "1px solid var(--color-border-default)",
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
      pt={dialogPt}
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p
            className="text-[0.85em]"
            style={{ color: "var(--color-danger)" }}
          >
            {error}
          </p>
        )}
        <label className="flex flex-col gap-2 text-[0.85em]">
          <span>Changelist Number</span>
          {changelistNumber !== null ? (
            <InputText
              className="w-full"
              value={String(changelistNumber)}
              disabled
              style={inputStyle}
            />
          ) : (
            <InputText
              className="w-full"
              value={clNumber}
              onChange={(e) => setClNumber(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. 42"
              keyfilter="int"
              disabled={isPending}
              style={inputStyle}
            />
          )}
        </label>
        <label className="flex flex-col gap-2 text-[0.85em]">
          <span>Label Name</span>
          <InputText
            ref={inputRef}
            className="w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. v1.0.0"
            disabled={isPending}
            style={inputStyle}
          />
        </label>
      </div>
    </Dialog>
  );
}
