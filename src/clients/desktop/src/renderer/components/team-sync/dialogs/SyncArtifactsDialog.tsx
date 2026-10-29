import { useEffect, useState } from "react";
import { Dialog } from "primereact/dialog";
import type { TeamSyncArtifactChannel } from "@checkpointvcs/common";
import { ipc } from "../../../pages/ipc";
import { Button } from "../../ui";
import { CheckRow, teamSyncDialogPt } from "./shared";

export interface SyncArtifactsDialogProps {
  visible: boolean;
  onHide: () => void;
  /** The artifact channels in the repo config. */
  channels: TeamSyncArtifactChannel[];
  /** The types this workspace syncs now. */
  selected: string[];
}

/**
 * Picks which artifact types (build outputs uploaded for changelists) this
 * workspace applies on sync. None by default. Saves on its own, apart from
 * the settings dialog's Save.
 */
export default function SyncArtifactsDialog({
  visible,
  onHide,
  channels,
  selected,
}: SyncArtifactsDialogProps): React.ReactElement {
  const [pending, setPending] = useState<string[]>([]);

  useEffect(() => {
    if (visible) setPending(selected);
  }, [visible, selected]);

  // A chosen type the config no longer has stays listed so it can be cleared.
  const known = new Set(channels.map((c) => c.type));
  const rows: { type: string; label: string; hint?: string }[] = [
    ...channels.map((c) => ({
      type: c.type,
      label: c.name ? `${c.name} (${c.type})` : c.type,
      ...(c.requiredBadges.length > 0 && {
        hint: `Only from changelists where ${c.requiredBadges.join(", ")} passed`,
      }),
    })),
    ...selected
      .filter((type) => !known.has(type))
      .map((type) => ({
        type,
        label: type,
        hint: "Not in the repo's teamsync.yaml any more",
      })),
  ];

  const toggle = (type: string): void => {
    setPending((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const handleSave = (): void => {
    ipc.sendMessage("team-sync:update-settings", {
      settings: { artifactTypes: pending },
    });
    onHide();
  };

  return (
    <Dialog
      header="Sync Artifacts"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: "32rem" }}
      pt={teamSyncDialogPt}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onHide}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-5">
        <p className="m-0 text-sm text-[var(--color-text-secondary)]">
          Each sync applies the newest upload of the types you choose, at or
          before the changelist you sync to. Clearing a type removes its files
          on the next sync.
        </p>
        {rows.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            This repo's teamsync.yaml defines no artifact types.
          </div>
        ) : (
          rows.map((row) => (
            <CheckRow
              key={row.type}
              checked={pending.includes(row.type)}
              onChange={() => toggle(row.type)}
              label={row.label}
              hint={row.hint}
            />
          ))
        )}
      </div>
    </Dialog>
  );
}
