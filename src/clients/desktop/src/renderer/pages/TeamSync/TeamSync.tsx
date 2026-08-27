import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router";
import { currentWorkspaceAtom } from "../../../common/state/workspace";
import { ipc } from "../ipc";
import TitleBar from "../../components/TitleBar";
import { Button } from "../../components/ui";
import StatusPanel from "../../components/team-sync/StatusPanel";
import ChangelistBrowser from "../../components/team-sync/ChangelistBrowser";
import LogPane from "../../components/team-sync/LogPane";
import TeamSyncSettingsDialog from "../../components/team-sync/dialogs/TeamSyncSettingsDialog";
import CleanWorkspaceDialog from "../../components/team-sync/dialogs/CleanWorkspaceDialog";
import BisectPanel from "../../components/team-sync/dialogs/BisectPanel";

export default function TeamSync(): React.ReactElement {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const navigate = useNavigate();
  const workspaceId = currentWorkspace?.id ?? null;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [bisectShown, setBisectShown] = useState(false);

  // Enter Team Sync for this workspace on mount so main fetches project info,
  // config, settings, and history and starts its head poll. Leave on unmount.
  useEffect(() => {
    if (!workspaceId) return;
    ipc.sendMessage("team-sync:enter", { workspaceId });
    return () => {
      ipc.sendMessage("team-sync:exit", null);
    };
  }, [workspaceId]);

  const handleFilesView = (): void => {
    ipc.sendMessage("team-sync:exit", null);
    navigate("/workspace");
  };

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      <TitleBar
        left={
          <>
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Team Sync
            </span>
            <span className="app-no-drag">
              <Button variant="secondary" size="sm" onClick={handleFilesView}>
                Files view
              </Button>
            </span>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <StatusPanel
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenClean={() => setCleanOpen(true)}
          onToggleBisect={() => setBisectShown((prev) => !prev)}
        />
        <BisectPanel
          forceShow={bisectShown}
          onClose={() => setBisectShown(false)}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChangelistBrowser />
        </div>
        <LogPane />
      </div>

      <TeamSyncSettingsDialog
        visible={settingsOpen}
        onHide={() => setSettingsOpen(false)}
      />
      <CleanWorkspaceDialog
        visible={cleanOpen}
        onHide={() => setCleanOpen(false)}
      />
    </div>
  );
}
