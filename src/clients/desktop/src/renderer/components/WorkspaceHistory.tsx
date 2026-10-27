import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceHistoryAtom,
  changelistChangesAtom,
  workspaceBranchesAtom,
} from "../../common/state/workspace";
import { Button } from "./ui";
import { ipc } from "../pages/ipc";
import { TreeTable } from "primereact/treetable";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TreeNode } from "primereact/treenode";
import { Column, ColumnPassThroughOptions } from "primereact/column";
import { ContextMenu } from "primereact/contextmenu";
import { MenuItem } from "primereact/menuitem";
import ChangelistChanges from "./ChangelistChanges";
import CreateLabelDialog from "./CreateLabelDialog";
import CreateBranchDialog from "./CreateBranchDialog";

// Column indexes (in render order) that size to their content. Every other
// column (Message) gets no explicit width, so the fixed table layout gives it
// the remaining space.
const CONTENT_SIZED_COLUMNS = [0, 2, 3];
// Keep a long value (e.g. an email) from squeezing Message out entirely.
const MAX_CONTENT_COLUMN_WIDTH = 320;
// Rows measured per pass; plenty to find the widest value without walking
// a very long history.
const MAX_MEASURED_ROWS = 500;

/** Natural width of a cell's content, ignoring the cell's current width. */
function measureContentWidth(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width;
}

function horizontalChrome(el: Element): number {
  const style = getComputedStyle(el);
  return (
    parseFloat(style.paddingLeft) +
    parseFloat(style.paddingRight) +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.borderRightWidth)
  );
}

/**
 * Sizes the content-sized columns to fit their widest header or cell. The
 * scrollable TreeTable renders the header and body as separate tables, each
 * with its own colgroup, so the width has to be set on both.
 */
function autoSizeColumns(wrapper: HTMLElement) {
  const headerTable = wrapper.querySelector(
    'table[data-pc-section="scrollableheadertable"]',
  );
  const bodyTable = wrapper.querySelector(
    'table[data-pc-section="scrollablebodytable"]',
  );
  if (!headerTable || !bodyTable) return;

  const headerCells = headerTable.querySelectorAll("thead > tr > th");
  const bodyRows = Array.from(bodyTable.querySelectorAll("tbody > tr")).slice(
    0,
    MAX_MEASURED_ROWS,
  );

  for (const index of CONTENT_SIZED_COLUMNS) {
    let width = 0;

    const th = headerCells[index];
    if (th) {
      // Measure the title + sort icon, not the th itself (which also holds
      // the absolutely positioned resize handle).
      const content = th.querySelector(".p-column-header-content") ?? th;
      width = measureContentWidth(content) + horizontalChrome(th);
    }

    for (const row of bodyRows) {
      const td = row.children[index];
      if (!td) continue;
      width = Math.max(width, measureContentWidth(td) + horizontalChrome(td));
    }

    if (width <= 0) continue;
    const px = `${Math.ceil(Math.min(width, MAX_CONTENT_COLUMN_WIDTH)) + 1}px`;

    for (const table of [headerTable, bodyTable]) {
      const col = table.querySelector("colgroup")?.children[index] as
        | HTMLElement
        | undefined;
      if (col) col.style.width = px;
    }
  }
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

export default function WorkspaceHistory() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspaceHistory = useAtomValue(workspaceHistoryAtom);
  const branchesState = useAtomValue(workspaceBranchesAtom);
  const changelistChanges = useAtomValue(changelistChangesAtom);

  const treeTableRef = useRef<TreeTable>(null);
  const contextMenuRef = useRef<ContextMenu>(null);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  // Once the user drags a column, stop auto-sizing so a refresh doesn't
  // undo their layout.
  const userResizedRef = useRef(false);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const contextChangelistRef = useRef<number | null>(null);
  const [createLabelVisible, setCreateLabelVisible] = useState(false);
  const [createLabelCl, setCreateLabelCl] = useState<number>(0);
  const [createBranchVisible, setCreateBranchVisible] = useState(false);
  const [createBranchCl, setCreateBranchCl] = useState<number>(0);

  useEffect(() => {
    if (!currentWorkspace) {
      setNodes([]);
      return;
    }

    if (!workspaceHistory) {
      setNodes([]);
      ipc.sendMessage("workspace:history", null);
      return;
    }

    const newNodes: TreeNode[] = [];

    for (const changelist of workspaceHistory) {
      const node: TreeNode = {
        id: changelist.id,
        key: changelist.id,
        data: {
          changelist: changelist.number,
          message: changelist.message,
          // Kept as epoch ms so sorting is chronological; formatted for
          // display by the Time column's body template.
          time: new Date(changelist.createdAt).getTime(),
          user: changelist.user?.email || "Unknown",
        },
      };

      newNodes.push(node);
    }

    setNodes(newNodes);
  }, [currentWorkspace, workspaceHistory]);

  // Runs after the rows are in the DOM, before paint, so there's no flash of
  // uniform columns. Also re-runs when the table remounts after returning
  // from the changelist details view.
  useLayoutEffect(() => {
    if (userResizedRef.current) return;
    const wrapper = tableWrapperRef.current;
    if (wrapper) autoSizeColumns(wrapper);
  }, [nodes]);

  const handleViewChanges = useCallback((changelistNumber: number) => {
    ipc.sendMessage("workspace:history:view-changes", { changelistNumber });
  }, []);

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, node: TreeNode) => {
      event.preventDefault();
      const changelistNumber = node.data?.changelist as number;
      contextChangelistRef.current = changelistNumber;

      const items: MenuItem[] = [
        {
          label: "View changes",
          command: () => {
            if (contextChangelistRef.current !== null) {
              handleViewChanges(contextChangelistRef.current);
            }
          },
        },
        { separator: true },
        {
          label: "Create branch here...",
          command: () => {
            if (contextChangelistRef.current !== null) {
              setCreateBranchCl(contextChangelistRef.current);
              setCreateBranchVisible(true);
            }
          },
        },
        {
          label: "Create label...",
          command: () => {
            if (contextChangelistRef.current !== null) {
              setCreateLabelCl(contextChangelistRef.current);
              setCreateLabelVisible(true);
            }
          },
        },
      ];

      setMenuItems(items);
      contextMenuRef.current?.show(event);
    },
    [handleViewChanges],
  );

  // Event delegation for double-click on table rows. This is a React prop
  // rather than a manual listener because the wrapper div unmounts while
  // ChangelistChanges is shown, and a mount-time listener would not be
  // re-attached to the new div when the user navigates back.
  const handleTableDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const row = target.closest("tr");
      if (!row) return;

      // Make sure it's a body row (not a header row)
      const tbody = row.closest("tbody");
      if (!tbody) return;

      const cells = row.querySelectorAll("td");
      if (cells.length > 0) {
        const changelistText = cells[0]?.textContent?.trim();
        const changelistNumber = changelistText
          ? parseInt(changelistText, 10)
          : NaN;
        if (!isNaN(changelistNumber)) {
          handleViewChanges(changelistNumber);
        }
      }
    },
    [handleViewChanges],
  );

  const columnPt = useMemo<ColumnPassThroughOptions>(
    () => ({
      headerCell: {
        style: {
          borderColor: "var(--color-border-default)",
          borderWidth: "0 1px 0 0",
          borderStyle: "solid",
          paddingLeft: "0.5rem",
        },
      },
      bodyCell: {
        style: {
          paddingLeft: "0.5rem",
        },
      },
      rowToggler: {
        className: "treetable-toggler",
        style: {
          backgroundColor: "transparent",
          padding: "0.4rem",
        },
      },
    }),
    [],
  );

  // Content-sized columns stay on one line so their measured width is the
  // full value; anything past the width cap is ellipsized.
  const compactColumnPt = useMemo<ColumnPassThroughOptions>(
    () => ({
      ...columnPt,
      bodyCell: {
        style: {
          paddingLeft: "0.5rem",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        },
      },
      headerCell: {
        style: {
          ...(columnPt.headerCell as { style: React.CSSProperties }).style,
          whiteSpace: "nowrap",
        },
      },
    }),
    [columnPt],
  );

  const treeTablePt = useMemo(
    () => ({
      thead: {
        style: {
          borderColor: "var(--color-border-default)",
          borderWidth: "0 0 1px 0",
          borderStyle: "solid",
          paddingLeft: "0.5rem",
        },
      },
      scrollableWrapper: {
        style: {
          height: "100%",
        },
      },
      scrollable: {
        style: {
          height: "100%",
        },
      },
      scrollableBody: {
        style: {
          maxHeight: "initial",
        },
      },
      resizeHelper: {
        style: {
          width: "0.1rem",
          backgroundColor: "var(--color-border-default)",
        },
      },
      tbody: {
        style: {
          cursor: "pointer",
        },
      },
    }),
    [],
  );

  // Show changelist changes view when active
  if (changelistChanges) {
    return <ChangelistChanges />;
  }

  return (
    <>
      <ContextMenu
        ref={contextMenuRef}
        model={menuItems}
        breakpoint="767px"
        pt={{
          root: {
            style: {
              marginTop: "2rem",
              backgroundColor: "var(--color-bg-overlay)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "0.5rem",
              minWidth: "200px",
            },
          },
          menu: {
            style: {
              backgroundColor: "var(--color-bg-overlay)",
            },
          },
          menuitem: {
            style: {
              margin: 0,
            },
          },
          action: {
            style: {
              color: "var(--color-text-secondary)",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
            },
          },
          separator: {
            style: {
              borderColor: "var(--color-border-muted)",
            },
          },
          submenuIcon: {
            style: {
              color: "var(--color-text-secondary)",
            },
          },
        }}
      />
      <div className="grid h-full grid-rows-[2.5rem_1fr]">
        <div className="row-span-1 flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3">
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
        <div
          className="row-span-1"
          style={{ textAlign: "left", overflow: "hidden" }}
          onDoubleClick={handleTableDoubleClick}
          ref={tableWrapperRef}
        >
          <TreeTable
            ref={treeTableRef}
            value={nodes}
            tableStyle={{ minWidth: "50rem" }}
            columnResizeMode="expand"
            resizableColumns
            showGridlines
            scrollable
            scrollHeight="flex"
            onContextMenu={(e) => {
              handleRowContextMenu(e.originalEvent as React.MouseEvent, e.node);
            }}
            onColumnResizeEnd={() => {
              userResizedRef.current = true;
            }}
            pt={treeTablePt}
            style={{ height: "100%" }}
          >
            <Column
              field="changelist"
              header="Changelist"
              expander
              resizeable
              sortable
              pt={compactColumnPt}
            ></Column>
            <Column
              field="message"
              header="Message"
              body={(node: TreeNode) => {
                const message = (node.data?.message as string) ?? "";
                // Block-level so the whole cell width shows the full
                // message (which may be clipped or multi-line) on hover.
                // whitespace-pre keeps the message's own line breaks; the
                // resizable table's td rule would otherwise collapse them.
                return (
                  <span
                    className="block overflow-hidden text-ellipsis whitespace-pre"
                    title={message}
                  >
                    {message}
                  </span>
                );
              }}
              resizeable
              sortable
              pt={columnPt}
            ></Column>
            <Column
              field="time"
              header="Time"
              body={(node: TreeNode) => formatChangelistTime(node.data?.time)}
              resizeable
              sortable
              pt={compactColumnPt}
            ></Column>
            <Column
              field="user"
              header="User"
              resizeable
              sortable
              pt={compactColumnPt}
            ></Column>
          </TreeTable>
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
        defaultParentBranchName={
          branchesState?.currentBranchName &&
          branchesState.branches.find(
            (b) => b.name === branchesState.currentBranchName,
          )?.type === "FEATURE"
            ? (branchesState.branches.find(
                (b) => b.name === branchesState.currentBranchName,
              )?.parentBranchName ?? branchesState.currentBranchName)
            : (branchesState?.currentBranchName ?? null)
        }
        defaultHeadNumber={createBranchCl}
        defaultType="FEATURE"
      />
    </>
  );
}
