import { useAtomValue } from "jotai";
import { useNavigate } from "react-router";
import WorkspaceMenu from "../../components/WorkspaceMenu";
import WorkspaceExplorer from "../../components/WorkspaceExplorer";
import WorkspacePendingChanges from "../../components/WorkspacePendingChanges";
import { useState } from "react";
import { Dropdown } from "primereact/dropdown";
import {
  currentWorkspaceAtom,
  workspacesAtom,
  workspaceSyncPreviewAtom,
} from "../../../common/state/workspace";
import { ipc } from "../ipc";
import WorkspaceHistory from "../../components/WorkspaceHistory";
import WorkspaceLabels from "../../components/WorkspaceLabels";
import WorkspaceBranches from "../../components/WorkspaceBranches";
import SyncPreview from "../../components/SyncPreview";
import SyncStatusBadge from "../../components/SyncStatusBadge";
import TitleBar from "../../components/TitleBar";
import { Badge, Button } from "../../components/ui";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCodeBranch } from "@fortawesome/free-solid-svg-icons/faCodeBranch";

const dropdownPt = {
  root: {
    className:
      "inline-flex items-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] pl-3 pr-2 py-1 transition-colors hover:border-[var(--color-text-muted)]",
  },
  input: {
    className:
      "text-sm text-[var(--color-text-primary)] outline-none bg-transparent",
  },
  trigger: { className: "ml-2 text-[var(--color-text-muted)]" },
};

export default function Workspace(): React.ReactElement {
  const workspaces = useAtomValue(workspacesAtom);
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const syncPreview = useAtomValue(workspaceSyncPreviewAtom);
  const [activeTabIndex, setActiveTabIndex] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(true);
  const navigate = useNavigate();

  const tabs = [
    <WorkspaceExplorer key="explorer" />,
    <WorkspacePendingChanges key="pending" />,
    <WorkspaceHistory key="history" />,
    <WorkspaceBranches key="branches" />,
    <WorkspaceLabels key="labels" />,
  ];

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      {/* Top bar doubles as the draggable window titlebar. */}
      <TitleBar
        left={
          <>
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Workspace
            </span>
            <span className="app-no-drag">
              <Dropdown
                value={currentWorkspace?.id}
                onChange={(e) => {
                  if (e.value === "configure") {
                    navigate("/dashboard");
                  } else {
                    ipc.sendMessage("workspace:select", {
                      id: e.value,
                    });
                  }
                }}
                options={(
                  workspaces?.map((ws) => ({
                    label: ws.name,
                    value: ws.id,
                  })) || []
                ).concat({ label: "Configure...", value: "configure" })}
                placeholder="Select a Workspace"
                pt={dropdownPt}
              />
            </span>
            {currentWorkspace && (
              <Badge variant="default" className="gap-1.5">
                <FontAwesomeIcon
                  icon={faCodeBranch}
                  style={{ color: "var(--color-branches)" }}
                />
                {currentWorkspace.branchName}
              </Badge>
            )}
            {currentWorkspace && (
              <span className="app-no-drag">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    ipc.sendMessage("team-sync:enter", {
                      workspaceId: currentWorkspace.id,
                    });
                    navigate("/team-sync");
                  }}
                >
                  Team Sync
                </Button>
              </span>
            )}
          </>
        }
      />

      {/* Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {syncPreview ? (
          <div className="relative w-full overflow-hidden">
            <SyncPreview />
          </div>
        ) : (
          <>
            <div
              className={`flex shrink-0 flex-col ${expanded ? "w-35" : "w-14"}`}
            >
              <WorkspaceMenu
                activeIndex={activeTabIndex}
                setActiveIndex={setActiveTabIndex}
                expanded={expanded}
                setExpanded={setExpanded}
              />
            </div>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              {tabs.map((tab, index) => (
                <div
                  key={index}
                  className={`absolute inset-0 ${
                    activeTabIndex === index ? "" : "hidden"
                  }`}
                >
                  {tab}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <footer className="flex h-6 shrink-0 items-center justify-end border-t border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
        <SyncStatusBadge />
      </footer>
    </div>
  );
}
