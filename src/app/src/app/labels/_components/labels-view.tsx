"use client";

import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import { LabelContextMenu } from "./label-context-menu";
import { RenameDialog } from "./rename-dialog";
import { ChangeChangelistDialog } from "./change-changelist-dialog";
import { CreateLabelDialog } from "./create-label-dialog";

interface Label {
  id: string;
  name: string;
  repoId: string;
  number: number;
  changelist: {
    number: number;
    message: string;
    createdAt: Date;
    user: { email: string; name: string | null } | null;
  };
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  label: Label | null;
}

export function LabelsView({ repoId }: { repoId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    label: null,
  });
  const [renameTarget, setRenameTarget] = useState<Label | null>(null);
  const [changeClTarget, setChangeClTarget] = useState<Label | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const {
    data: labels,
    isLoading,
    refetch,
  } = api.label.getLabels.useQuery({ repoId });

  const deleteLabel = api.label.deleteLabel.useMutation({
    onSuccess: () => {
      setError(null);
      void refetch();
    },
    onError: (err) => setError(err.message),
  });

  const renameLabel = api.label.renameLabel.useMutation({
    onSuccess: () => {
      setError(null);
      setRenameTarget(null);
      void refetch();
    },
    onError: (err) => setError(err.message),
  });

  const changeChangelist = api.label.changeChangelist.useMutation({
    onSuccess: () => {
      setError(null);
      setChangeClTarget(null);
      void refetch();
    },
    onError: (err) => setError(err.message),
  });

  const createLabel = api.label.createLabel.useMutation({
    onSuccess: () => {
      setError(null);
      setShowCreateDialog(false);
      void refetch();
    },
    onError: (err) => setError(err.message),
  });

  const handleContextMenu = (e: React.MouseEvent, label: Label) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, label });
  };

  const closeContextMenu = () => {
    setContextMenu({ visible: false, x: 0, y: 0, label: null });
  };

  const handleDelete = (label: Label) => {
    closeContextMenu();
    if (
      confirm(
        `Are you sure you want to delete the label "${label.name}"? This action cannot be undone.`,
      )
    ) {
      deleteLabel.mutate({ id: label.id, repoId });
    }
  };

  const handleRename = (label: Label) => {
    closeContextMenu();
    setRenameTarget(label);
  };

  const handleChangeChangelist = (label: Label) => {
    closeContextMenu();
    setChangeClTarget(label);
  };

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(date));
  };

  if (isLoading) {
    return (
      <div className="w-full max-w-5xl">
        <div className="rounded-lg border border-white/10 bg-white/5 p-6">
          <div className="animate-pulse text-gray-400">Loading labels...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl" ref={tableRef}>
      <div className="overflow-hidden rounded-lg border border-white/10 bg-white/5">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-white">
              Changelist Labels
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              Right-click a label to rename, change its changelist, or delete it
            </p>
          </div>
          <button
            onClick={() => setShowCreateDialog(true)}
            className="rounded-md bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[hsl(280,100%,60%)]"
          >
            Create Label
          </button>
        </div>

        {error && (
          <div className="mx-6 mt-4 rounded-md border border-red-500/50 bg-red-500/20 p-3 text-red-200">
            {error}
          </div>
        )}

        {!labels || labels.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-400">
            No labels found for this repository.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px]">
              <thead className="bg-white/5">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase">
                    Label
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase">
                    Changelist
                  </th>
                  <th className="hidden px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase sm:table-cell">
                    Message
                  </th>
                  <th className="hidden px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase md:table-cell">
                    Date
                  </th>
                  <th className="hidden px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase lg:table-cell">
                    Author
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {labels.map((label) => (
                  <tr
                    key={label.id}
                    className="cursor-context-menu transition-colors hover:bg-white/5"
                    onContextMenu={(e) => handleContextMenu(e, label as Label)}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-[hsl(280,100%,70%)]/20 px-2.5 py-0.5 text-sm font-medium text-[hsl(280,100%,70%)]">
                          {label.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="font-mono text-sm text-gray-300">
                        #{label.number}
                      </span>
                    </td>
                    <td className="hidden max-w-xs truncate px-6 py-4 sm:table-cell">
                      <span className="text-sm text-gray-300">
                        {label.changelist.message}
                      </span>
                    </td>
                    <td className="hidden px-6 py-4 whitespace-nowrap md:table-cell">
                      <span className="text-sm text-gray-300">
                        {formatDate(label.changelist.createdAt)}
                      </span>
                    </td>
                    <td className="hidden px-6 py-4 whitespace-nowrap lg:table-cell">
                      <span className="text-sm text-gray-300">
                        {label.changelist.user?.name ??
                          label.changelist.user?.email ??
                          "Unknown"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && contextMenu.label && (
        <LabelContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={contextMenu.label}
          onDelete={handleDelete}
          onRename={handleRename}
          onChangeChangelist={handleChangeChangelist}
          onClose={closeContextMenu}
        />
      )}

      {/* Rename Dialog */}
      {renameTarget && (
        <RenameDialog
          label={renameTarget}
          isPending={renameLabel.isPending}
          onConfirm={(newName) =>
            renameLabel.mutate({
              id: renameTarget.id,
              repoId,
              name: newName,
            })
          }
          onCancel={() => setRenameTarget(null)}
        />
      )}

      {/* Change Changelist Dialog */}
      {changeClTarget && (
        <ChangeChangelistDialog
          label={changeClTarget}
          isPending={changeChangelist.isPending}
          onConfirm={(newNumber) =>
            changeChangelist.mutate({
              id: changeClTarget.id,
              repoId,
              number: newNumber,
            })
          }
          onCancel={() => setChangeClTarget(null)}
        />
      )}

      {/* Create Label Dialog */}
      {showCreateDialog && (
        <CreateLabelDialog
          isPending={createLabel.isPending}
          onConfirm={(name, number) =>
            createLabel.mutate({ repoId, name, number })
          }
          onCancel={() => setShowCreateDialog(false)}
        />
      )}
    </div>
  );
}
