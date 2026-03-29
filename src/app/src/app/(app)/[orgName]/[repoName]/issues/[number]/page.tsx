"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Card, Button, Badge, Avatar, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useSession } from "~/app/_hooks/useSession";

export default function IssueDetailPage() {
  const params = useParams<{ orgName: string; repoName: string; number: string }>();
  const router = useRouter();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;
  const issueNumber = parseInt(params.number, 10);

  const session = useSession();
  const currentUserId = session?.user?.id;

  const { data: org } = api.org.getOrg.useQuery({ id: orgName, idIsName: true, includeUsers: true });
  const repoData = org?.repos?.find((r: { name: string }) => r.name === repoName);
  const members = (org as any)?.users ?? [];
  const utils = api.useUtils();

  const { data: issue, isLoading } = api.issue.get.useQuery(
    { repoId: repoData?.id ?? "", number: issueNumber },
    { enabled: !!repoData?.id },
  );

  const { data: allLabels } = api.issue.listLabels.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const { data: isSubscribed } = api.issue.isSubscribed.useQuery(
    { issueId: issue?.id ?? "" },
    { enabled: !!issue?.id },
  );

  useDocumentTitle(
    issue ? `${issue.title} #${issue.number} - ${repoName}` : `Issue #${issueNumber}`,
  );

  // ── Mutations ─────────────────────────────────────

  const closeIssue = api.issue.close.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const reopenIssue = api.issue.reopen.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const updateIssue = api.issue.update.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const addComment = api.issue.addComment.useMutation({
    onSuccess: () => {
      void utils.issue.get.invalidate();
      setNewComment("");
    },
  });
  const updateComment = api.issue.updateComment.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const deleteComment = api.issue.deleteComment.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const addLabel = api.issue.addLabelToIssue.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const removeLabel = api.issue.removeLabelFromIssue.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const addAssignee = api.issue.addAssignee.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const removeAssignee = api.issue.removeAssignee.useMutation({
    onSuccess: () => void utils.issue.get.invalidate(),
  });
  const subscribeMut = api.issue.subscribe.useMutation({
    onSuccess: () => void utils.issue.isSubscribed.invalidate(),
  });
  const unsubscribeMut = api.issue.unsubscribe.useMutation({
    onSuccess: () => void utils.issue.isSubscribed.invalidate(),
  });

  // ── Local state ───────────────────────────────────

  const [newComment, setNewComment] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [editBody, setEditBody] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");

  // ── Handlers ──────────────────────────────────────

  const handleSubmitComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!issue || !newComment.trim()) return;
    addComment.mutate({ issueId: issue.id, body: newComment.trim() });
  };

  const handleSaveTitle = () => {
    if (!issue || !repoData || !editTitle.trim()) return;
    updateIssue.mutate({ repoId: repoData.id, number: issue.number, title: editTitle.trim() });
    setEditingTitle(false);
  };

  const handleSaveBody = () => {
    if (!issue || !repoData) return;
    updateIssue.mutate({ repoId: repoData.id, number: issue.number, body: editBody });
    setEditingBody(false);
  };

  const handleSaveComment = (commentId: string) => {
    if (!editCommentBody.trim()) return;
    updateComment.mutate({ commentId, body: editCommentBody.trim() });
    setEditingCommentId(null);
  };

  const handleDeleteComment = (commentId: string) => {
    if (!confirm("Delete this comment?")) return;
    deleteComment.mutate({ commentId });
  };

  const isAuthor = currentUserId === issue?.authorId;

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Loading...</div>;
  }

  if (!issue) {
    return <EmptyState title="Issue not found" description={`Could not find issue #${issueNumber}.`} />;
  }

  const currentLabelIds = new Set(issue.labels?.map((ll: any) => ll.label.id) ?? []);
  const currentAssigneeIds = new Set(issue.assignees?.map((a: any) => a.user.id) ?? []);

  return (
    <div>
      {/* Title */}
      <div className="mb-4">
        {editingTitle ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-lg font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
            />
            <Button size="sm" onClick={handleSaveTitle}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditingTitle(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
              {issue.title}{" "}
              <span className="font-normal text-[var(--color-text-muted)]">#{issue.number}</span>
            </h1>
            {isAuthor && (
              <button
                type="button"
                onClick={() => { setEditTitle(issue.title); setEditingTitle(true); }}
                className="shrink-0 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Edit
              </button>
            )}
          </div>
        )}

        <div className="mt-1 flex items-center gap-2 text-sm">
          <Badge variant={issue.status === "OPEN" ? "success" : "danger"}>
            {issue.status}
          </Badge>
          <span className="text-[var(--color-text-secondary)]">
            {issue.author?.name ?? issue.author?.email} opened this issue on{" "}
            {new Date(issue.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Main content */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* Description */}
          <Card>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                <Avatar
                  src={issue.author?.image}
                  name={issue.author?.name}
                  email={issue.author?.email}
                  size="sm"
                />
                <span className="font-medium text-[var(--color-text-primary)]">
                  {issue.author?.name ?? issue.author?.email}
                </span>
              </div>
              {isAuthor && !editingBody && (
                <button
                  type="button"
                  onClick={() => { setEditBody(issue.body); setEditingBody(true); }}
                  className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  Edit
                </button>
              )}
            </div>
            <div className="mt-3">
              {editingBody ? (
                <div className="space-y-2">
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={8}
                    className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveBody}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingBody(false)}>Cancel</Button>
                  </div>
                </div>
              ) : issue.body ? (
                <div className="prose-sm text-[var(--color-text-primary)]">
                  {issue.body.split("\n").map((line: string, i: number) => {
                    if (line.trim() === "") return <br key={i} />;
                    return <p key={i} className="mb-1 text-sm">{line}</p>;
                  })}
                </div>
              ) : (
                <p className="text-sm text-[var(--color-text-muted)] italic">No description provided.</p>
              )}
            </div>
          </Card>

          {/* Comments */}
          {issue.comments?.map((comment: any) => (
            <Card key={comment.id}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <Avatar
                    src={comment.author?.image}
                    name={comment.author?.name}
                    email={comment.author?.email}
                    size="sm"
                  />
                  <span className="font-medium text-[var(--color-text-primary)]">
                    {comment.author?.name ?? comment.author?.email}
                  </span>
                  <span>
                    {new Date(comment.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  {comment.updatedAt !== comment.createdAt && (
                    <span className="text-xs italic">(edited)</span>
                  )}
                </div>
                {currentUserId === comment.authorId && editingCommentId !== comment.id && (
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => { setEditingCommentId(comment.id); setEditCommentBody(comment.body); }}
                      className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteComment(comment.id)}
                      className="text-[var(--color-danger)] hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-2">
                {editingCommentId === comment.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editCommentBody}
                      onChange={(e) => setEditCommentBody(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => handleSaveComment(comment.id)}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingCommentId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--color-text-primary)]">
                    {comment.body.split("\n").map((line: string, i: number) => {
                      if (line.trim() === "") return <br key={i} />;
                      return <p key={i} className="mb-1">{line}</p>;
                    })}
                  </div>
                )}
              </div>
            </Card>
          ))}

          {/* New comment */}
          <Card>
            <form onSubmit={handleSubmitComment} className="space-y-3">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Leave a comment... (Markdown supported)"
                rows={4}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
              />
              <div className="flex items-center justify-between">
                <div>
                  {issue.status === "OPEN" ? (
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => repoData && closeIssue.mutate({ repoId: repoData.id, number: issue.number })}
                      disabled={closeIssue.isPending}
                    >
                      Close issue
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={() => repoData && reopenIssue.mutate({ repoId: repoData.id, number: issue.number })}
                      disabled={reopenIssue.isPending}
                    >
                      Reopen issue
                    </Button>
                  )}
                </div>
                <Button type="submit" disabled={!newComment.trim() || addComment.isPending}>
                  {addComment.isPending ? "Posting..." : "Comment"}
                </Button>
              </div>
            </form>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="w-56 shrink-0 space-y-4">
          {/* Labels */}
          <Card>
            <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--color-text-muted)]">
              Labels
            </h3>
            {issue.labels?.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {issue.labels.map((ll: any) => (
                  <span
                    key={ll.label.id}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
                    style={{ backgroundColor: ll.label.color }}
                  >
                    {ll.label.name}
                    <button
                      type="button"
                      onClick={() => removeLabel.mutate({ issueId: issue.id, labelId: ll.label.id })}
                      className="ml-0.5 opacity-70 hover:opacity-100"
                      title="Remove label"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
            {allLabels && allLabels.filter((l: any) => !currentLabelIds.has(l.id)).length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addLabel.mutate({ issueId: issue.id, labelId: e.target.value });
                }}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
              >
                <option value="">Add label...</option>
                {allLabels
                  .filter((l: any) => !currentLabelIds.has(l.id))
                  .map((l: any) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
              </select>
            )}
          </Card>

          {/* Assignees */}
          <Card>
            <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--color-text-muted)]">
              Assignees
            </h3>
            {issue.assignees?.length > 0 && (
              <div className="mb-2 space-y-1">
                {issue.assignees.map((a: any) => (
                  <div key={a.user.id} className="flex items-center gap-2 text-sm">
                    <Avatar src={a.user.image} name={a.user.name} email={a.user.email} size="sm" />
                    <span className="flex-1 truncate text-[var(--color-text-primary)]">
                      {a.user.name ?? a.user.email}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAssignee.mutate({ issueId: issue.id, userId: a.user.id })}
                      className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                      title="Remove assignee"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            )}
            {members && members.filter((m: any) => !currentAssigneeIds.has(m.user.id)).length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) addAssignee.mutate({ issueId: issue.id, userId: e.target.value });
                }}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
              >
                <option value="">Add assignee...</option>
                {members
                  .filter((m: any) => !currentAssigneeIds.has(m.user.id))
                  .map((m: any) => (
                    <option key={m.user.id} value={m.user.id}>
                      {m.user.name ?? m.user.email}
                    </option>
                  ))}
              </select>
            )}
          </Card>

          {/* Subscription */}
          <Card>
            <h3 className="mb-2 text-xs font-semibold uppercase text-[var(--color-text-muted)]">
              Notifications
            </h3>
            <button
              type="button"
              onClick={() => {
                if (!issue) return;
                if (isSubscribed) {
                  unsubscribeMut.mutate({ issueId: issue.id });
                } else {
                  subscribeMut.mutate({ issueId: issue.id });
                }
              }}
              disabled={subscribeMut.isPending || unsubscribeMut.isPending}
              className={`w-full rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                isSubscribed
                  ? "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  : "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
              }`}
            >
              {isSubscribed ? "Unsubscribe" : "Subscribe"}
            </button>
            <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
              {isSubscribed
                ? "You\u2019re receiving notifications for this issue."
                : "Subscribe to get notified of updates."}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}