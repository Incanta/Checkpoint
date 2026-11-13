import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceHistoryAtom,
  changelistChangesAtom,
  workspaceBranchesAtom,
} from "../../common/state/workspace";
import {
  Button,
  ContextMenu,
  DataTable,
  EmptyState,
  type ContextMenuHandle,
  type MenuItem,
} from "./ui";
import { ipc } from "../pages/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faClockRotateLeft } from "@fortawesome/free-solid-svg-icons";
import ChangelistChanges from "./ChangelistChanges";
import CreateLabelDialog from "./CreateLabelDialog";
import CreateBranchDialog from "./CreateBranchDialog";

interface HistoryRow {
  id: string;
  changelist: number;
  message: string;
  /** Epoch ms, so sorting is chronological. */
  time: number;
  timeLabel: string;
  user: string;
}

/** Local date plus a 12-hour time, e.g. "10/27/2026, 3:42 PM". */
function formatChangelistTime(epochMs: number | undefined): string {
  if (epochMs === undefined || isNaN(epochMs)) return "";
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const column = createColumnHelper<HistoryRow>();

const columns = [
  column.accessor("changelist", {
    id: "changelist",
    header: "Changelist",
    meta: { measure: (row) => String(row.changelist) },
  }),
  column.accessor("message", {
    id: "message",
    header: "Message",
    minSize: 200,
    // whitespace-pre keeps the message's own line breaks; the full text
    // also shows on hover, since long lines are clipped.
    cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
    meta: { fill: true, cellClassName: "whitespace-pre" },
  }),
  column.accessor("time", {
    id: "time",
    header: "Time",
    cell: (info) => info.row.original.timeLabel,
    meta: { measure: (row) => row.timeLabel },
  }),
  column.accessor("user", {
    id: "user",
    header: "User",
    meta: { measure: (row) => row.user },
  }),
];

export default function WorkspaceHistory() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceHistory = useAtomValue(workspaceHistoryAtom);
  const branchesState = useAtomValue(workspaceBranchesAtom);
  const changelistChanges = useAtomValue(changelistChangesAtom);

  const contextMenuRef = useRef<ContextMenuHandle>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [createLabelVisible, setCreateLabelVisible] = useState(false);
  const [createLabelCl, setCreateLabelCl] = useState<number>(0);
  const [createBranchVisible, setCreateBranchVisible] = useState(false);
  const [createBranchCl, setCreateBranchCl] = useState<number>(0);

  useEffect(() => {
    if (currentWorkspace && !workspaceHistory) {
      ipc.sendMessage("workspace:history", null);
    }
  }, [currentWorkspace, workspaceHistory]);

  const rows = useMemo<HistoryRow[]>(() => {
    if (!currentWorkspace || !workspaceHistory) return [];
    return workspaceHistory.map((changelist) => {
      const time = new Date(changelist.createdAt).getTime();
      return {
        id: changelist.id,
        changelist: changelist.number,
        message: changelist.message ?? "",
        time,
        timeLabel: formatChangelistTime(time),
        user: changelist.user?.email || "Unknown",
      };
    });
  }, [currentWorkspace, workspaceHistory]);

  const handleViewChanges = useCallback((changelistNumber: number) => {
    ipc.sendMessage("workspace:history:view-changes", { changelistNumber });
  }, []);

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, row: HistoryRow) => {
      event.preventDefault();
      const changelistNumber = row.changelist;
      setMenuItems([
        {
          label: "View changes",
          command: () => handleViewChanges(changelistNumber),
        },
        { separator: true },
        {
          label: "Create branch here...",
          command: () => {
            setCreateBranchCl(changelistNumber);
            setCreateBranchVisible(true);
          },
        },
        {
          label: "Create label...",
          command: () => {
            setCreateLabelCl(changelistNumber);
            setCreateLabelVisible(true);
          },
        },
      ]);
      contextMenuRef.current?.show(event);
    },
    [handleViewChanges],
  );

  const currentBranch = branchesState?.branches.find(
    (b) => b.name === branchesState.currentBranchName,
  );
  const defaultParentBranchName =
    currentBranch?.type === "FEATURE"
      ? (currentBranch.parentBranchName ?? currentBranch.name)
      : (branchesState?.currentBranchName ?? null);

  // The table stays mounted (just hidden) while a changelist's details are
  // open, so its sorting, scroll position, and selection are still there on
  // the way back.
  return (
    <>
      {changelistChanges && <ChangelistChanges />}
      <ContextMenu ref={contextMenuRef} model={menuItems} />
      <div
        className={`grid h-full grid-rows-[2.5rem_minmax(0,1fr)] ${
          changelistChanges ? "hidden" : ""
        }`}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              ipc.sendMessage("workspace:history", null);
            }}
          >
            Refresh
          </Button>
        </div>
        <div className="min-h-0 min-w-0 overflow-hidden">
          <DataTable
            data={rows}
            columns={columns}
            getRowId={(row) => row.id}
            storageKey="workspace-history"
            onRowActivate={(row) => handleViewChanges(row.changelist)}
            onRowContextMenu={handleRowContextMenu}
            emptyState={
              workspaceHistory ? (
                <EmptyState
                  icon={<FontAwesomeIcon icon={faClockRotateLeft} size="2x" />}
                  title="No History"
                  description="Submitted changelists will show up here."
                />
              ) : null
            }
          />
        </div>
      </div>

      <CreateLabelDialog
        visible={createLabelVisible}
        changelistNumber={createLabelCl}
        onHide={() => setCreateLabelVisible(false)}
      />

      <CreateBranchDialog
        visible={createBranchVisible}
        onHide={() => setCreateBranchVisible(false)}
        defaultParentBranchName={defaultParentBranchName}
        defaultHeadNumber={createBranchCl}
        defaultType="FEATURE"
      />
    </>
  );
}
