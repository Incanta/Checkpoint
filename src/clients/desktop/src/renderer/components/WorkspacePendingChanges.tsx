import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Dialog } from "primereact/dialog";
import type { MenuItem } from "primereact/menuitem";
import { Splitter, SplitterPanel } from "primereact/splitter";
import { useAtomValue } from "jotai";
import {
  currentWorkspaceAtom,
  workspaceDiffAtom,
  workspacePendingChangelistsAtom,
  workspacePendingChangesAtom,
  workspaceNestedAtom,
  workspaceBranchesAtom,
} from "../../common/state/workspace";
import { ipc } from "../pages/ipc";
import DropdownButton from "./DropdownButton";
import styles from "./Editor.module.css";
// @ts-ignore
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  getLanguageFromPath,
  MONACO_THEME,
  prepareMonacoHighlighting,
} from "../syntax/monaco-highlighting";
import { FileStatus } from "@checkpointvcs/daemon/types";
import type {
  File as PendingFile,
  PendingChangelistState,
} from "@checkpointvcs/daemon/types";
import FileContextMenu, { useFileContextMenu } from "./FileContextMenu";
import { Button, EmptyState } from "./ui";
import StagedChangesTree, {
  UNSTAGED,
  type Bucket,
  type PendingSelection,
  type PendingTreeNode,
} from "./StagedChangesTree";
import {
  ChangelistBranchDialog,
  ChangelistDescriptionDialog,
  SubmitChangelistDialog,
} from "./PendingChangelistDialogs";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck } from "@fortawesome/free-solid-svg-icons/faCircleCheck";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import { faTableColumns } from "@fortawesome/free-solid-svg-icons/faTableColumns";

type DiffLayout = "horizontal" | "vertical";

const LAYOUT_STORAGE_KEY = "checkpoint.pending.diffLayout";

function readLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_STORAGE_KEY) === "vertical"
      ? "vertical"
      : "horizontal";
  } catch {
    /* localStorage unavailable */
    return "horizontal";
  }
}

const NO_CHANGELISTS: PendingChangelistState = {
  changelists: [],
  assignments: {},
  defaultDescriptions: {},
};

// Mirrors destinedBranch/changelistOf in the daemon's pending-changelists
// util, which decide what a submit sends: the renderer cannot import the
// daemon's runtime code, and the page must group files the way submit will.
function destinedBranch(file: PendingFile, domain: string): string {
  const claim = file.claims.find((c) => c.state === "OPEN") ?? file.claims[0];
  return claim?.branchName ?? domain;
}

function changelistOf(
  file: PendingFile,
  state: PendingChangelistState,
  domain: string,
): number | null {
  const id = state.assignments[file.path];
  if (id === undefined) return null;
  const changelist = state.changelists.find((c) => c.id === id);
  if (!changelist) return null;
  return changelist.branchName === destinedBranch(file, domain) ? id : null;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/**
 * Workspaces nested in this one (Team Sync nested linked repos, or any
 * folder with its own .checkpoint) that have pending changes. Their files
 * never show here, since they belong to the other repo, so this says where
 * the work is and opens that workspace. Empty (and takes no space) when
 * there is nothing to show.
 */
function NestedPendingStrip(): React.ReactElement {
  const nested = useAtomValue(workspaceNestedAtom).filter(
    (n) => n.workspaceId !== null && (n.pendingCount ?? 0) > 0,
  );
  return (
    <div className="row-span-1">
      {nested.map((n) => (
        <div
          key={n.path}
          className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-info)]/10 px-3 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono">{n.path}</span> is another workspace
            {n.workspaceName ? ` (${n.workspaceName})` : ""} with{" "}
            {n.pendingCount} pending change{n.pendingCount === 1 ? "" : "s"}.
            Submit them from there.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              ipc.sendMessage("workspace:select", { id: n.workspaceId! })
            }
          >
            Open
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function WorkspacePendingChanges() {
  const currentWorkspace = useAtomValue(currentWorkspaceAtom);
  const workspacePendingChanges = useAtomValue(workspacePendingChangesAtom);
  const pendingChangelists =
    useAtomValue(workspacePendingChangelistsAtom) ?? NO_CHANGELISTS;
  const workspaceDiff = useAtomValue(workspaceDiffAtom);

  const domain = currentWorkspace?.domainBranchName ?? "main";
  const branches = useMemo(
    () => [domain, ...(currentWorkspace?.activeBranches ?? [])],
    [domain, currentWorkspace],
  );

  // Sections, top to bottom: each branch's default changelist followed by
  // its numbered ones (the domain root first, then each overlay), and
  // UNSTAGED last. A staged file's section is its numbered changelist when
  // it has one on the branch its claim names, else that branch's default.
  const buckets = useMemo<Bucket[]>(() => {
    const files = Object.values(workspacePendingChanges?.files ?? {});
    const sections: Bucket[] = [];
    const byId = new Map<string, Bucket>();
    const add = (bucket: Bucket) => {
      sections.push(bucket);
      byId.set(bucket.id, bucket);
    };
    const addDefault = (branch: string) =>
      add({
        id: `default:${branch}`,
        kind: "default",
        label: branch,
        branchName: branch,
        changelistId: null,
        description: pendingChangelists.defaultDescriptions[branch] ?? "",
        files: [],
      });

    for (const branch of branches) {
      addDefault(branch);
      for (const cl of pendingChangelists.changelists
        .filter((c) => c.branchName === branch)
        .sort((a, b) => a.id - b.id)) {
        add({
          id: `cl:${cl.id}`,
          kind: "numbered",
          label: branch === domain ? `#${cl.id}` : `#${cl.id} (${branch})`,
          branchName: branch,
          changelistId: cl.id,
          description: cl.description,
          files: [],
        });
      }
    }

    const unstaged: Bucket = {
      id: UNSTAGED,
      kind: "unstaged",
      label: "Unstaged",
      branchName: null,
      changelistId: null,
      description: "",
      files: [],
    };

    for (const file of files) {
      if (!file.staged) {
        unstaged.files.push(file);
        continue;
      }
      const changelist = changelistOf(file, pendingChangelists, domain);
      const branch = destinedBranch(file, domain);
      // A claim on a branch this workspace does not have active still gets
      // a section, so the file is visible rather than silently dropped.
      if (changelist === null && !byId.has(`default:${branch}`)) {
        addDefault(branch);
      }
      byId
        .get(changelist !== null ? `cl:${changelist}` : `default:${branch}`)!
        .files.push(file);
    }

    sections.push(unstaged);
    return sections;
  }, [workspacePendingChanges, pendingChangelists, branches, domain]);

  const ownRows = useMemo(
    () => new Set(Object.keys(workspacePendingChanges?.files ?? {})),
    [workspacePendingChanges],
  );

  const [selection, setSelection] = useState<PendingSelection | null>(null);
  // The file the diff editor was last asked to show. Once it is no longer
  // pending (reverted, submitted), the editor clears as if it were deselected.
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const showDiff =
    workspaceDiff !== null && diffPath !== null && ownRows.has(diffPath);
  const [layout, setLayout] = useState<DiffLayout>(readLayout);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Dialogs. The submit dialog follows its section by id, so it shows the
  // section's current files after a refresh.
  const [submitBucketId, setSubmitBucketId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [editBucket, setEditBucket] = useState<Bucket | null>(null);
  const [branchBucketId, setBranchBucketId] = useState<string | null>(null);
  const branchBucket = buckets.find((b) => b.id === branchBucketId) ?? null;

  // Feature branches a changelist can move to by activating them here: not
  // archived, not already active, and stacked on something that is.
  const workspaceBranches = useAtomValue(workspaceBranchesAtom);
  const inactiveBranches = useMemo(
    () =>
      (workspaceBranches?.branches ?? [])
        .filter(
          (b) =>
            b.type === "FEATURE" &&
            !b.archivedAt &&
            !branches.includes(b.name) &&
            b.parentBranchName !== null &&
            branches.includes(b.parentBranchName),
        )
        .map((b) => b.name),
    [workspaceBranches, branches],
  );
  const [createFor, setCreateFor] = useState<{ paths: string[] } | null>(null);
  const submitBucket = buckets.find((b) => b.id === submitBucketId) ?? null;

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    } catch {
      /* localStorage unavailable */
    }
  }, [layout]);

  // ─── Diff editor ──────────────────────────────────────────────────
  // The host element changes when the layout flips (the splitter remounts),
  // so the editor follows the element rather than being created once.
  const [monacoHost, setMonacoHost] = useState<HTMLDivElement | null>(null);
  const [editor, setEditor] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);

  // The diff for a new selection arrives after diffPath changes, so read the
  // path when the diff lands instead of rebuilding the models on each click.
  const diffPathRef = useRef(diffPath);
  diffPathRef.current = diffPath;

  useEffect(() => {
    if (!monacoHost) return;
    void prepareMonacoHighlighting();
    const created = monaco.editor.createDiffEditor(monacoHost, {
      theme: MONACO_THEME,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
    });
    setEditor(created);
    return () => {
      const model = created.getModel();
      created.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      setEditor(null);
    };
  }, [monacoHost]);

  useEffect(() => {
    if (!editor || !workspaceDiff) return;
    const previous = editor.getModel();
    const language = getLanguageFromPath(diffPathRef.current ?? "");
    editor.setModel({
      original: monaco.editor.createModel(workspaceDiff.left, language),
      modified: monaco.editor.createModel(workspaceDiff.right, language),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [editor, workspaceDiff]);

  // ─── Submit ───────────────────────────────────────────────────────
  /** The submit awaiting its result: what it was, and with which text. */
  const submitInFlight = useRef<{
    description: string;
    target: { changelistId: number } | { branchName: string };
  } | null>(null);

  useEffect(() => {
    const unsubscribeSuccess = ipc.on("workspace:submit:success", () => {
      submitInFlight.current = null;
      setIsSubmitting(false);
      setSubmitBucketId(null);
      setSelection(null);
      ipc.sendMessage("workspace:refresh", null);
    });

    // Failures of stage, unstage, and changelist edits arrive here too; only
    // a failed submit belongs in the submit dialog.
    const unsubscribeError = ipc.on("workspace:submit:error", (data) => {
      setIsSubmitting(false);
      const failed = submitInFlight.current;
      submitInFlight.current = null;
      if (!failed) {
        setErrorMessage(data.message);
        return;
      }
      setSubmitError(data.message);
      // Keep the text typed in the dialog, so trying again (or coming back
      // to it later) does not mean retyping it. Saved only on failure: after
      // a success the changelist and its description are gone.
      ipc.sendMessage("workspace:pending-cl:set-description", {
        description: failed.description,
        ...failed.target,
      });
    });

    return () => {
      unsubscribeSuccess();
      unsubscribeError();
    };
  }, []);

  const targetOf = (
    bucket: Bucket,
  ): { changelistId: number } | { branchName: string } =>
    bucket.changelistId !== null
      ? { changelistId: bucket.changelistId }
      : { branchName: bucket.branchName! };

  const handleSubmit = (description: string) => {
    if (!submitBucket) return;
    const target = targetOf(submitBucket);
    submitInFlight.current = { description, target };
    setSubmitError(null);
    setIsSubmitting(true);
    ipc.sendMessage("workspace:submit", { message: description, ...target });
  };

  // ─── Staging ──────────────────────────────────────────────────────
  const moveTo = useCallback((paths: string[], to: Bucket) => {
    if (paths.length === 0) return;
    if (to.kind === "unstaged") {
      ipc.sendMessage("workspace:unstage", { paths });
    } else if (to.changelistId !== null) {
      ipc.sendMessage("workspace:stage", {
        paths,
        changelistId: to.changelistId,
      });
    } else {
      ipc.sendMessage("workspace:stage", {
        paths,
        branchName: to.branchName!,
      });
    }
  }, []);

  const handleSelectionChange = useCallback(
    (next: PendingSelection | null, clicked: PendingTreeNode | null) => {
      setSelection(next);
      // Directories have nothing to diff; they only stand in for their files.
      if (clicked && !clicked.isDirectory) {
        setDiffPath(clicked.path);
        ipc.sendMessage("workspace:diff:file", { path: clicked.path });
      }
    },
    [],
  );

  // ─── Context menu ─────────────────────────────────────────────────
  const {
    contextMenuRef,
    showContextMenu,
    buildMenuItems,
    currentFileRef,
    lockedWarningVisible,
    setLockedWarningVisible,
    lockedWarningPath,
    lockedWarningUser,
    confirmLockedCheckout,
    resolveDialogVisible,
    setResolveDialogVisible,
    resolveDialogPath,
    resolveDontAsk,
    setResolveDontAsk,
    resolveDontAskDuration,
    setResolveDontAskDuration,
    confirmResolve,
  } = useFileContextMenu();
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);

  /** Stage/unstage/move for the selection, above the per-file actions. */
  const stagingItems = (sel: PendingSelection): MenuItem[] => {
    const from = buckets.find((b) => b.id === sel.bucketId);
    if (!from) return [];
    const disabled = !sel.actionable || isSubmitting;
    const count = sel.paths.length > 1 ? ` ${sel.paths.length} items` : "";
    return [
      ...moveItems(sel, from, disabled, count),
      {
        label: "Revert if Unchanged",
        disabled: isSubmitting || sel.paths.length === 0,
        command: () =>
          ipc.sendMessage("workspace:revert-unchanged", {
            filePaths: sel.paths,
          }),
      },
    ];
  };

  /** Stage/unstage/move for the selection. */
  const moveItems = (
    sel: PendingSelection,
    from: (typeof buckets)[number],
    disabled: boolean,
    count: string,
  ): MenuItem[] => {
    const targets: MenuItem[] = buckets
      .filter((b) => b.kind !== "unstaged" && b.id !== from.id)
      .map((b) => ({
        label:
          b.kind === "default"
            ? `${b.label} (default)`
            : `${b.label}${b.description ? `  ${firstLine(b.description)}` : ""}`,
        command: () => moveTo(sel.paths, b),
      }));
    targets.push(...(targets.length > 0 ? [{ separator: true }] : []), {
      label: "New changelist...",
      command: () => setCreateFor({ paths: sel.paths }),
    });

    if (from.kind === "unstaged") {
      return [
        {
          label: `Stage${count}`,
          disabled,
          command: () =>
            moveTo(
              sel.paths,
              buckets.find((b) => b.id === `default:${domain}`)!,
            ),
        },
        { label: "Stage to", disabled, items: targets },
      ];
    }
    return [
      {
        label: `Unstage${count}`,
        disabled,
        command: () =>
          moveTo(sel.paths, buckets.find((b) => b.kind === "unstaged")!),
      },
      { label: "Move to", disabled, items: targets },
    ];
  };

  const handleContextMenu = (
    event: React.MouseEvent,
    node: PendingTreeNode,
    sel: PendingSelection,
  ) => {
    if (!currentWorkspace) return;
    const workspaceLocalPath = currentWorkspace.localPath
      .split(/[/\\]/)
      .join("/");

    // The per-file actions below the staging ones apply to the clicked row.
    currentFileRef.current = {
      absolutePath: workspaceLocalPath + "/" + node.path,
      relativePath: node.path,
      isDirectory: node.isDirectory,
      status: node.file ? (FileStatus[node.file.status] ?? "") : "",
      hasChangelist: node.file?.changelist != null,
      changelistId: node.file?.changelist ?? null,
    };
    // Render the items before showing, so the menu measures its real
    // height when deciding whether it fits below the cursor.
    flushSync(() => setMenuItems(buildMenuItems(stagingItems(sel))));
    showContextMenu(event, currentFileRef.current);
  };

  const hasChanges = buckets.some((b) => b.files.length > 0);
  const horizontal = layout === "horizontal";

  const filesPanel = (
    <div className="h-full w-full overflow-auto p-2">
      {hasChanges || pendingChangelists.changelists.length > 0 ? (
        <StagedChangesTree
          buckets={buckets}
          selection={selection}
          onSelectionChange={handleSelectionChange}
          onContextMenu={handleContextMenu}
          onMove={(paths, _from, to) => moveTo(paths, to)}
          onSubmit={(bucket) => {
            setSubmitError(null);
            setSubmitBucketId(bucket.id);
          }}
          onEditDescription={setEditBucket}
          onChangeBranch={(bucket) => {
            // The branch list is only loaded by the Branches page otherwise.
            ipc.sendMessage("workspace:branches", null);
            setBranchBucketId(bucket.id);
          }}
          onDelete={(bucket) => {
            if (
              window.confirm(
                `Delete changelist ${bucket.label}? Its files stay staged and move to the ${bucket.branchName} default changelist.`,
              )
            ) {
              ipc.sendMessage("workspace:pending-cl:delete", {
                changelistId: bucket.changelistId!,
              });
            }
          }}
          disabled={isSubmitting}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <EmptyState
            icon={<FontAwesomeIcon icon={faCircleCheck} size="2x" />}
            title="No Pending Changes"
            description="Your workspace is up to date. Edited files will show up here."
          />
        </div>
      )}
    </div>
  );

  const diffPanel = showDiff ? (
    <div className={styles.Editor} ref={setMonacoHost} />
  ) : (
    <div className="flex h-full w-full items-center justify-center bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-muted)]">
      Select a file to view the diff
    </div>
  );

  return (
    <div className="grid h-full grid-rows-[2.5rem_auto_1fr]">
      <div className="row-span-1 flex items-center gap-2 bg-[var(--color-bg-secondary)] px-3">
        <DropdownButton
          className="px-3 py-1 text-xs"
          label="Refresh"
          disabled={isSubmitting}
          onClick={() => {
            ipc.sendMessage("workspace:refresh", null);
          }}
          items={[
            {
              label: "Refresh (Reload Ignore/Hidden)",
              onClick: () => {
                ipc.sendMessage("workspace:refresh-ignores", null);
              },
            },
            {
              label: "Revert Unchanged Files",
              onClick: () => {
                ipc.sendMessage("workspace:revert-unchanged", {
                  filePaths: null,
                });
              },
            },
          ]}
        />
        <Button
          variant="secondary"
          size="sm"
          title={
            horizontal
              ? "Diff is beside the files; click to show it below"
              : "Diff is below the files; click to show it beside"
          }
          onClick={() => setLayout(horizontal ? "vertical" : "horizontal")}
        >
          <FontAwesomeIcon
            icon={faTableColumns}
            rotation={horizontal ? undefined : 90}
          />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={isSubmitting}
          onClick={() => setCreateFor({ paths: [] })}
        >
          <FontAwesomeIcon icon={faPlus} />
          New Changelist
        </Button>
      </div>
      <NestedPendingStrip />
      <div className="row-span-1 overflow-hidden text-left">
        <Splitter
          key={layout}
          layout={horizontal ? "horizontal" : "vertical"}
          className="h-full w-full"
          pt={{
            gutter: {
              className: "pending-changes-splitter-gutter",
            },
          }}
        >
          <SplitterPanel
            className="flex overflow-hidden"
            size={horizontal ? 40 : 55}
            minSize={15}
            style={{ opacity: isSubmitting ? 0.5 : 1 }}
          >
            {filesPanel}
          </SplitterPanel>
          <SplitterPanel
            className="flex overflow-hidden"
            size={horizontal ? 60 : 45}
            minSize={15}
            style={{ opacity: isSubmitting ? 0.5 : 1 }}
          >
            {diffPanel}
          </SplitterPanel>
        </Splitter>
      </div>

      <SubmitChangelistDialog
        bucket={submitBucket}
        ownRows={ownRows}
        submitting={isSubmitting}
        error={submitError}
        onSubmit={handleSubmit}
        onHide={() => setSubmitBucketId(null)}
      />

      <ChangelistDescriptionDialog
        visible={editBucket !== null}
        header={editBucket ? `Edit ${editBucket.label}` : "Edit changelist"}
        confirmLabel="Save"
        initialDescription={editBucket?.description ?? ""}
        onHide={() => setEditBucket(null)}
        onConfirm={(description) => {
          if (editBucket) {
            ipc.sendMessage("workspace:pending-cl:set-description", {
              description,
              ...targetOf(editBucket),
            });
          }
          setEditBucket(null);
        }}
      />

      <ChangelistBranchDialog
        bucket={branchBucket}
        activeBranches={branches}
        inactiveBranches={inactiveBranches}
        onHide={() => setBranchBucketId(null)}
        onConfirm={(branchName, createBranch) => {
          if (branchBucket?.changelistId != null) {
            ipc.sendMessage("workspace:pending-cl:set-branch", {
              changelistId: branchBucket.changelistId,
              branchName,
              createBranch,
            });
          }
          setBranchBucketId(null);
        }}
      />

      <ChangelistDescriptionDialog
        visible={createFor !== null}
        header="New Changelist"
        confirmLabel="Create"
        initialDescription=""
        branches={branches}
        onHide={() => setCreateFor(null)}
        onConfirm={(description, branchName) => {
          ipc.sendMessage("workspace:pending-cl:create", {
            description,
            ...(branchName ? { branchName } : {}),
            ...(createFor?.paths.length ? { paths: createFor.paths } : {}),
          });
          setCreateFor(null);
        }}
      />

      <Dialog
        header="Error"
        visible={errorMessage !== null}
        style={{ width: "30rem" }}
        onHide={() => setErrorMessage(null)}
        footer={
          <Button size="sm" onClick={() => setErrorMessage(null)}>
            OK
          </Button>
        }
        pt={{
          root: {
            style: {
              backgroundColor: "var(--color-bg-secondary)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "0.5rem",
              overflow: "hidden",
            },
          },
          header: {
            style: {
              backgroundColor: "var(--color-bg-secondary)",
              color: "var(--color-text-primary)",
              fontWeight: 600,
              borderBottom: "1px solid var(--color-border-default)",
            },
          },
          content: {
            style: {
              backgroundColor: "var(--color-bg-secondary)",
              color: "var(--color-text-secondary)",
              padding: "1.5rem",
            },
          },
          footer: {
            style: {
              backgroundColor: "var(--color-bg-secondary)",
              borderTop: "1px solid var(--color-border-default)",
              padding: "0.75rem",
            },
          },
        }}
      >
        <p className="m-0">{errorMessage}</p>
      </Dialog>

      <FileContextMenu
        contextMenuRef={contextMenuRef}
        menuItems={menuItems}
        lockedWarningVisible={lockedWarningVisible}
        setLockedWarningVisible={setLockedWarningVisible}
        lockedWarningUser={lockedWarningUser}
        lockedWarningPath={lockedWarningPath}
        confirmLockedCheckout={confirmLockedCheckout}
        resolveDialogVisible={resolveDialogVisible}
        setResolveDialogVisible={setResolveDialogVisible}
        resolveDialogPath={resolveDialogPath}
        resolveDontAsk={resolveDontAsk}
        setResolveDontAsk={setResolveDontAsk}
        resolveDontAskDuration={resolveDontAskDuration}
        setResolveDontAskDuration={setResolveDontAskDuration}
        confirmResolve={confirmResolve}
      />
    </div>
  );
}
