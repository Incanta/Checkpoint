import { useState, useEffect, useCallback } from "react";
import {
  Button,
  Dialog,
  dialogFieldClass,
  dialogInputClass,
  dialogSelectClass,
} from "./ui";
import { ipc } from "../pages/ipc";

export interface CreateBranchDialogProps {
  visible: boolean;
  onHide: () => void;
  defaultParentBranchName: string | null;
  defaultHeadNumber: number;
  defaultType: "MAINLINE" | "RELEASE" | "FEATURE";
}

const typeOptions = [
  { label: "Feature", value: "FEATURE" },
  { label: "Release", value: "RELEASE" },
  { label: "Mainline", value: "MAINLINE" },
];

export default function CreateBranchDialog(props: CreateBranchDialogProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"MAINLINE" | "RELEASE" | "FEATURE">(
    props.defaultType,
  );
  const [parentBranchName, setParentBranchName] = useState<string | null>(
    props.defaultParentBranchName,
  );
  const [headNumber, setHeadNumber] = useState<number>(props.defaultHeadNumber);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the dialog opens
  useEffect(() => {
    if (props.visible) {
      setName("");
      setType(props.defaultType);
      setParentBranchName(props.defaultParentBranchName);
      setHeadNumber(props.defaultHeadNumber);
      setPending(false);
      setError(null);
    }
  }, [
    props.visible,
    props.defaultType,
    props.defaultParentBranchName,
    props.defaultHeadNumber,
  ]);

  // Listen for success/error
  useEffect(() => {
    const unsubSuccess = ipc.on("workspace:create-branch:success", () => {
      setPending(false);
      props.onHide();
    });
    const unsubError = ipc.on("workspace:create-branch:error", (data) => {
      setPending(false);
      setError(data.message);
    });
    return () => {
      unsubSuccess();
      unsubError();
    };
  }, [props.onHide]);

  const handleCreate = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);

    // Mainline branches have no parent
    const effectiveParent = type === "MAINLINE" ? null : parentBranchName;

    ipc.sendMessage("workspace:create-branch", {
      name: trimmed,
      headNumber,
      type,
      parentBranchName: effectiveParent,
    });
  }, [name, headNumber, type, parentBranchName]);

  return (
    <Dialog
      header="Create Branch"
      visible={props.visible}
      style={{ width: "30rem" }}
      onHide={() => {
        if (!pending) props.onHide();
      }}
      closable={!pending}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onHide} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={pending || !name.trim()}>
            {pending ? "Creating..." : "Create"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className={dialogFieldClass}>
          <span>Branch name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) handleCreate();
            }}
            autoFocus
            disabled={pending}
            className={dialogInputClass}
          />
        </label>

        <label className={dialogFieldClass}>
          <span>Branch type</span>
          <select
            value={type}
            onChange={(e) =>
              setType(e.target.value as "MAINLINE" | "RELEASE" | "FEATURE")
            }
            disabled={pending}
            className={dialogSelectClass}
          >
            {typeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {type !== "MAINLINE" && (
          <label className={dialogFieldClass}>
            <span>Parent branch</span>
            <input
              value={parentBranchName ?? ""}
              onChange={(e) => setParentBranchName(e.target.value || null)}
              disabled={pending}
              className={dialogInputClass}
            />
          </label>
        )}

        <label className={dialogFieldClass}>
          <span>Starting changelist number</span>
          <input
            type="number"
            min={0}
            step={1}
            value={headNumber}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              setHeadNumber(isNaN(parsed) || parsed < 0 ? 0 : parsed);
            }}
            disabled={pending}
            className={dialogInputClass}
          />
        </label>

        {error && (
          <p className="m-0 text-[0.85em] text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
