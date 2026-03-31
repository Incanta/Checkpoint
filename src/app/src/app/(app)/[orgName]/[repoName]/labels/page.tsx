"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Badge, Button, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function RepoLabelsPage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  useDocumentTitle(`Labels · ${repoName} in ${orgName}`);

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: labels } = api.label.getLabels.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );
  const utils = api.useUtils();

  const { data: access } = api.repo.getMyRepoAccess.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNumber, setNewNumber] = useState("");

  const createLabel = api.label.createLabel.useMutation({
    onSuccess: () => {
      setShowCreate(false);
      setNewName("");
      setNewNumber("");
      void utils.label.getLabels.invalidate();
    },
  });

  const deleteLabel = api.label.deleteLabel.useMutation({
    onSuccess: () => void utils.label.getLabels.invalidate(),
  });

  return (
    <div>
      <div className="mb-4 flex justify-end">
        {access?.canWrite && (
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            New label
          </Button>
        )}
      </div>

      {showCreate && (
        <Card className="mb-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!repoData || !newName.trim() || !newNumber) return;
              createLabel.mutate({
                repoId: repoData.id,
                name: newName.trim(),
                number: parseInt(newNumber, 10),
              });
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                Label name
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="v1.0"
                autoFocus
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="w-32">
              <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
                CL #
              </label>
              <input
                type="number"
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                min={0}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <Button size="sm" type="submit" disabled={createLabel.isPending}>
              Create
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </form>
          {createLabel.error && (
            <p className="mt-2 text-sm text-[var(--color-danger)]">{createLabel.error.message}</p>
          )}
        </Card>
      )}

      {labels && labels.length > 0 ? (
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-default)]">
            {labels.map((label) => (
              <div
                key={label.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {label.name}
                  </span>
                  <Badge variant="accent">CL #{label.number}</Badge>
                </div>
                {access?.canWrite && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      repoData &&
                      deleteLabel.mutate({ repoId: repoData.id, id: label.id })
                    }
                    className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                  >
                    Delete
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No labels"
          description="Labels help you tag important versions like releases."
          action={
            access?.canWrite ? (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                Create your first label
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
