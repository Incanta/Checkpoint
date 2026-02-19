import { useState, useEffect, useCallback } from "react";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import Button from "./Button";
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

  const dialogPt = {
    root: {
      style: {
        backgroundColor: "var(--color-panel)",
        border: "1px solid var(--color-border)",
      },
    },
    header: {
      style: {
        backgroundColor: "var(--color-panel)",
        color: "var(--color-text-secondary)",
        borderBottom: "1px solid var(--color-border)",
      },
    },
    content: {
      style: {
        backgroundColor: "var(--color-panel)",
        color: "var(--color-text-secondary)",
        padding: "1.5rem",
      },
    },
    footer: {
      style: {
        backgroundColor: "var(--color-panel)",
        borderTop: "1px solid var(--color-border)",
        padding: "0.75rem",
      },
    },
  };

  const inputStyle = {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text-secondary)",
    border: "1px solid var(--color-border-light)",
    width: "100%",
  };

  return (
    <Dialog
      header="Create Branch"
      visible={props.visible}
      style={{ width: "28rem" }}
      onHide={() => {
        if (!pending) props.onHide();
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            label="Cancel"
            onClick={props.onHide}
            disabled={pending}
            className="p-[0.5rem] text-[0.9em]"
          />
          <Button
            label={pending ? "Creating..." : "Create"}
            onClick={handleCreate}
            disabled={pending || !name.trim()}
            className="p-[0.5rem] text-[0.9em]"
          />
        </div>
      }
      pt={dialogPt}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="branch-name"
            style={{ color: "#aaa", fontSize: "0.85em" }}
          >
            Branch name
          </label>
          <InputText
            id="branch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) handleCreate();
            }}
            autoFocus
            style={inputStyle}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="branch-type"
            style={{ color: "#aaa", fontSize: "0.85em" }}
          >
            Branch type
          </label>
          <Dropdown
            id="branch-type"
            value={type}
            onChange={(e) => setType(e.value)}
            options={typeOptions}
            style={inputStyle}
          />
        </div>

        {type !== "MAINLINE" && (
          <div className="flex flex-col gap-1">
            <label
              htmlFor="branch-parent"
              style={{ color: "#aaa", fontSize: "0.85em" }}
            >
              Parent branch
            </label>
            <InputText
              id="branch-parent"
              value={parentBranchName ?? ""}
              onChange={(e) => setParentBranchName(e.target.value || null)}
              style={inputStyle}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label
            htmlFor="branch-head"
            style={{ color: "#aaa", fontSize: "0.85em" }}
          >
            Starting changelist number
          </label>
          <InputNumber
            id="branch-head"
            value={headNumber}
            onValueChange={(e) => setHeadNumber(e.value ?? 0)}
            min={0}
            useGrouping={false}
            style={inputStyle}
            inputStyle={inputStyle}
          />
        </div>

        {error && <small style={{ color: "#ff6b6b" }}>{error}</small>}
      </div>
    </Dialog>
  );
}
