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

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCodeBranch } from "@fortawesome/free-solid-svg-icons/faCodeBranch";

export default function Workspace(): React.ReactElement {
  const workspaces = useAtomValue(workspacesAtom);
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const syncPreview = useAtomValue(workspaceSyncPreviewAtom);
  const [activeTabIndex, setActiveTabIndex] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(true);
  const navigate = useNavigate();

  return (
    <div className="grid grid-rows-[2.5rem_calc(100vh-4rem-30px)_1.5rem] gap-4">
      <div
        className="row-span-1 flex"
        style={{
          backgroundColor: "var(--color-panel)",
          borderColor: "var(--color-border)",
          borderWidth: "0 0 1px 0",
          borderStyle: "solid",
          zIndex: 1,
          alignItems: "center",
          marginLeft: "0.5rem",
        }}
      >
        <span className="mr-[0.5rem]">Workspace:</span>
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
            workspaces?.map((ws) => ({ label: ws.name, value: ws.id })) || []
          ).concat({ label: "Configure...", value: "configure" })}
          placeholder="Select a Workspace"
          pt={{
            trigger: {
              style: {
                marginLeft: "0.2rem",
              },
            },
          }}
        />
        {currentWorkspace && (
          <span
            className="ml-4 flex items-center"
            style={{ color: "var(--color-text-secondary)", fontSize: "0.85em" }}
          >
            <FontAwesomeIcon
              icon={faCodeBranch}
              style={{ color: "var(--color-branches)", marginRight: "0.3rem" }}
            />
            {currentWorkspace.branchName}
          </span>
        )}
      </div>
      <div className="row-span-1 flex">
        {syncPreview ? (
          <div style={{ width: "100%" }}>
            <SyncPreview />
          </div>
        ) : (
          <div
            className={`grid grid-cols-[8rem_calc(100vw-8rem)] [&.collapsed]:grid-cols-[3rem_calc(100vw-3rem)] w-full ${!expanded ? "collapsed" : ""}`}
          >
            <div className="col-span-1 flex w-full">
              <WorkspaceMenu
                activeIndex={activeTabIndex}
                setActiveIndex={setActiveTabIndex}
                expanded={expanded}
                setExpanded={setExpanded}
              />
            </div>
            <div className="col-span-1 flex">
              <div
                style={{
                  display: activeTabIndex === 0 ? "initial" : "none",
                  width: "100%",
                }}
              >
                <WorkspaceExplorer />
              </div>
              <div
                style={{
                  display: activeTabIndex === 1 ? "initial" : "none",
                  width: "100%",
                }}
              >
                <WorkspacePendingChanges />
              </div>
              <div
                style={{
                  display: activeTabIndex === 2 ? "initial" : "none",
                  width: "100%",
                }}
              >
                <WorkspaceHistory />
              </div>
              <div
                style={{
                  display: activeTabIndex === 3 ? "initial" : "none",
                  width: "100%",
                }}
              >
                <WorkspaceBranches />
              </div>
              <div
                style={{
                  display: activeTabIndex === 4 ? "initial" : "none",
                  width: "100%",
                }}
              >
                <WorkspaceLabels />
              </div>
            </div>
          </div>
        )}
      </div>
      <div
        className="row-span-1 flex"
        style={{
          backgroundColor: "var(--color-panel-strong)",
          borderColor: "var(--color-border)",
          borderWidth: "1px 0 0 0",
          borderStyle: "solid",
          zIndex: 1,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <SyncStatusBadge />
      </div>
    </div>
  );
}
