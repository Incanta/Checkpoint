import { useAtom } from "jotai";
import { authAttemptAtom } from "../../../common/state/auth";
import { useNavigate } from "react-router-dom";
import WorkspaceMenu from "../../components/WorkspaceMenu";
import { Splitter, SplitterPanel } from "primereact/splitter";

export default function Page(): React.ReactElement {
  return (
    <div className="grid grid-rows-3 gap-4">
      <div className="row-span-1 flex justify-center items-center">
        {/* Workspace breadcrumb selector (Account > Org > Repo > Workspace > Branch) */}
      </div>
      <div className="row-span-1 flex justify-center items-center">
        {/* Sidebar */}
        <Splitter>
          <SplitterPanel>
            <WorkspaceMenu />
          </SplitterPanel>
          <SplitterPanel>{/* Content */}</SplitterPanel>
        </Splitter>
      </div>
      <div className="row-span-1 flex justify-center items-center">
        {/* footer */}
      </div>
    </div>
  );
}
