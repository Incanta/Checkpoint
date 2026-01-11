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
} from "../../../common/state/workspace";
import { ipc } from "../ipc";
import WorkspaceHistory from "../../components/WorkspaceHistory";

export default function Workspace(): React.ReactElement {
  const workspaces = useAtomValue(workspacesAtom);
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const [activeTabIndex, setActiveTabIndex] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(true);
  const navigate = useNavigate();

  return (
    <div className="grid grid-rows-[2.5rem_calc(100vh-4rem-30px)_1.5rem] gap-4">
      <div
        className="row-span-1 flex"
        style={{
          backgroundColor: "#2C2C2C",
          borderColor: "#1A1A1A",
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
      </div>
      <div className="row-span-1 flex">
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
            {activeTabIndex === 0 && <WorkspaceExplorer />}
            {activeTabIndex === 1 && <WorkspacePendingChanges />}
            {activeTabIndex === 2 && <WorkspaceHistory />}
          </div>
        </div>
      </div>
      <div
        className="row-span-1 flex"
        style={{
          backgroundColor: "#383838",
          borderColor: "#1A1A1A",
          borderWidth: "1px 0 0 0",
          borderStyle: "solid",
          zIndex: 1,
        }}
      >
        {/* footer */}
      </div>
    </div>
  );
}
