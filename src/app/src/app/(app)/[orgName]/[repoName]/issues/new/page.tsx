"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Button, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

export default function NewIssuePage() {
  const params = useParams<{ orgName: string; repoName: string }>();
  const router = useRouter();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;
  useDocumentTitle(`New Issue - ${repoName} in ${orgName}`);

  const { data: org } = api.org.getOrg.useQuery({ id: orgName, idIsName: true });
  const repoData = org?.repos?.find((r: { name: string }) => r.name === repoName);

  const { data: labels } = api.issue.listLabels.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const { data: members } = api.org.getMembers.useQuery(
    { orgId: org?.id ?? "" },
    { enabled: !!org?.id },
  );

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);

  const createIssue = api.issue.create.useMutation({
    onSuccess: (data) => {
      router.push(`${basePath}/issues/${data.number}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoData?.id || !title.trim()) return;
    createIssue.mutate({
      repoId: repoData.id,
      title: title.trim(),
      body,
      labelIds: selectedLabels,
      assigneeIds: selectedAssignees,
    });
  };

  const toggleLabel = (id: string) => {
    setSelectedLabels((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
    );
  };

  const toggleAssignee = (id: string) => {
    setSelectedAssignees((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  return (
    <div>
      <div className="flex gap-6">
        {/* Main form */}
        <div className="flex-1">
          <Card>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Issue title"
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  autoFocus
                />
              </div>

              <div>
                <div className="mb-2 flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setPreview(false)}
                    className={`px-2 py-1 rounded ${!preview ? "bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}
                  >
                    Write
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreview(true)}
                    className={`px-2 py-1 rounded ${preview ? "bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}
                  >
                    Preview
                  </button>
                </div>

                {preview ? (
                  <div className="min-h-[200px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-3">
                    <MarkdownPreview content={body} />
                  </div>
                ) : (
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Describe the issue... (Markdown supported)"
                    rows={10}
                    className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  />
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.push(`${basePath}/issues`)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!title.trim() || createIssue.isPending}
                >
                  {createIssue.isPending ? "Creating..." : "Create Issue"}
                </Button>
              </div>

              {createIssue.isError && (
                <p className="text-sm text-[var(--color-danger)]">
                  {createIssue.error.message}
                </p>
              )}
            </form>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="w-56 shrink-0 space-y-4">
          {/* Labels */}
          {labels && labels.length > 0 && (
            <Card>
              <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--color-text-muted)]">
                Labels
              </h3>
              <div className="space-y-1">
                {labels.map((l: any) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => toggleLabel(l.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${
                      selectedLabels.includes(l.id)
                        ? "bg-[var(--color-bg-overlay)]"
                        : "hover:bg-[var(--color-bg-surface)]"
                    }`}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: l.color }}
                    />
                    <span className="truncate text-[var(--color-text-primary)]">{l.name}</span>
                    {selectedLabels.includes(l.id) && (
                      <span className="ml-auto text-[var(--color-accent)]">&#10003;</span>
                    )}
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* Assignees */}
          {members && members.length > 0 && (
            <Card>
              <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--color-text-muted)]">
                Assignees
              </h3>
              <div className="space-y-1">
                {members.map((m: any) => (
                  <button
                    key={m.user.id}
                    type="button"
                    onClick={() => toggleAssignee(m.user.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${
                      selectedAssignees.includes(m.user.id)
                        ? "bg-[var(--color-bg-overlay)]"
                        : "hover:bg-[var(--color-bg-surface)]"
                    }`}
                  >
                    <span className="truncate text-[var(--color-text-primary)]">
                      {m.user.name ?? m.user.email}
                    </span>
                    {selectedAssignees.includes(m.user.id) && (
                      <span className="ml-auto text-[var(--color-accent)]">&#10003;</span>
                    )}
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  if (!content.trim()) {
    return <p className="text-sm text-[var(--color-text-muted)]">Nothing to preview</p>;
  }
  // Simple markdown-ish rendering for preview
  const lines = content.split("\n").map((line, i) => {
    if (line.startsWith("# ")) return <h1 key={i} className="text-lg font-bold">{line.slice(2)}</h1>;
    if (line.startsWith("## ")) return <h2 key={i} className="text-base font-bold">{line.slice(3)}</h2>;
    if (line.startsWith("### ")) return <h3 key={i} className="text-sm font-bold">{line.slice(4)}</h3>;
    if (line.startsWith("- ")) return <li key={i} className="ml-4 list-disc text-sm">{line.slice(2)}</li>;
    if (line.trim() === "") return <br key={i} />;
    return <p key={i} className="text-sm">{line}</p>;
  });
  return <div className="prose-sm text-[var(--color-text-primary)]">{lines}</div>;
}