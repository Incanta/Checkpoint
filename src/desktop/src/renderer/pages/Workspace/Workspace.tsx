import { useAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import WorkspaceMenu from "../../components/WorkspaceMenu";
import { Splitter, SplitterPanel } from "primereact/splitter";
import { TabView, TabPanel } from "primereact/tabview";
import WorkspaceExplorer from "../../components/WorkspaceExplorer";
import WorkspacePendingChanges from "../../components/WorkspacePendingChanges";
import { useState } from "react";

export default function Page(): React.ReactElement {
  const [activeTabIndex, setActiveTabIndex] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(true);

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
        }}
      >
        {/* Workspace breadcrumb selector (User > Org > Repo > Workspace > Branch) */}
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
