import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import { ipc } from "../../../pages/ipc";
import { Button } from "../../ui";
import { teamSyncDialogPt, textareaClass } from "./shared";

export interface CommentDialogProps {
  changelistNumber: number;
  onClose: () => void;
}

/**
 * Leave a comment on a changelist. Replaces the old `window.prompt` flow in the
 * changelist browser with a proper multi-line editor.
 */
export default function CommentDialog({
  changelistNumber,
  onClose,
}: CommentDialogProps): React.ReactElement {
  const [body, setBody] = useState("");

  useEffect(() => {
    setBody("");
  }, [changelistNumber]);

  const handleSubmit = (): void => {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    ipc.sendMessage("team-sync:comment", {
      changelistNumber,
      body: trimmed,
    });
    onClose();
  };

  return (
    <Dialog
      header={`Comment on CL ${changelistNumber}`}
      visible
      onHide={onClose}
      modal
      dismissableMask
      style={{ width: "30rem" }}
      pt={teamSyncDialogPt}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={body.trim().length === 0}>
            Submit
          </Button>
        </div>
      }
    >
      <div className="p-5">
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Share what you found on this changelist..."
          className={textareaClass}
        />
      </div>
    </Dialog>
  );
}
