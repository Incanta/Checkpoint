"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, type RouterOutputs } from "~/trpc/react";
import { Button, Card, Badge, Avatar, EmptyState } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";
import { useIssueLinker } from "~/app/_hooks/use-issue-linker";
import { MarkdownContent } from "~/app/_components/markdown";
import { useSession } from "~/lib/auth-client";
import { diffLines } from "diff";

// ── Virtual file list (reused from history page pattern) ────────
const ITEM_HEIGHT = 28;
const VISIBLE_COUNT = 50;
const BUFFER = 20;

function VirtualFileList({
  files,
  renderItem,
}: {
  files: { path: string; type: string }[];
  renderItem: (
    file: { path: string; type: string },
    idx: number,
  ) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  if (files.length <= 70) {
    return <>{files.map((f, i) => renderItem(f, i))}</>;
  }

  const totalHeight = files.length * ITEM_HEIGHT;
  const maxH = Math.min(VISIBLE_COUNT * ITEM_HEIGHT, 1400);
  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
  const endIdx = Math.min(
    files.length,
    Math.ceil((scrollTop + maxH) / ITEM_HEIGHT) + BUFFER,
  );

  return (
    <div>
      <div className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
        {files.length} files changed
      </div>
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{ maxHeight: maxH, overflowY: "auto" }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: startIdx * ITEM_HEIGHT,
              left: 0,
              right: 0,
            }}
          >
            {files
              .slice(startIdx, endIdx)
              .map((f, i) => renderItem(f, startIdx + i))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Review state colors ────────────────────────────────────────
const REVIEW_BADGE: Record<
  string,
  { variant: "success" | "danger" | "default"; label: string }
> = {
  APPROVED: { variant: "success", label: "Approved" },
  REQUEST_CHANGES: { variant: "danger", label: "Changes requested" },
  PENDING: { variant: "default", label: "Pending" },
};

const FILE_TYPE_COLOR: Record<string, "success" | "warning" | "danger"> = {
  ADD: "success",
  MODIFY: "warning",
  DELETE: "danger",
};

// ── Main page ──────────────────────────────────────────────────
export default function MergeRequestDetailPage() {
  const params = useParams<{
    orgName: string;
    repoName: string;
    mrNumber: string;
  }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const mrNumber = parseInt(params.mrNumber, 10);
  const router = useRouter();
  const { data: session } = useSession();
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: mr, isLoading } = api.mergeRequest.get.useQuery(
    { repoId: repoData?.id ?? "", number: mrNumber },
    { enabled: !!repoData?.id },
  );

  const { data: isSubscribed } = api.mergeRequest.isSubscribed.useQuery(
    { mergeRequestId: mr?.id ?? "" },
    { enabled: !!mr?.id },
  );

  useDocumentTitle(
    mr
      ? `${mr.title} #${mr.number} · ${repoName} in ${orgName}`
      : `MR #${mrNumber} · ${repoName}`,
  );

  const [activeTab, setActiveTab] = useState<
    "discussion" | "history" | "changes"
  >("discussion");

  const invalidateMr = () => {
    void utils.mergeRequest.get.invalidate();
    void utils.mergeRequest.list.invalidate();
    void utils.mergeRequest.countOpen.invalidate();
  };

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const updateMr = api.mergeRequest.update.useMutation({
    onSuccess: invalidateMr,
  });
  const subscribeMut = api.mergeRequest.subscribe.useMutation({
    onSuccess: () => void utils.mergeRequest.isSubscribed.invalidate(),
  });
  const unsubscribeMut = api.mergeRequest.unsubscribe.useMutation({
    onSuccess: () => void utils.mergeRequest.isSubscribed.invalidate(),
  });
  const isAuthor = session?.user?.id === mr?.authorId;

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }
  if (!mr) {
    return (
      <EmptyState title="Not found" description="Merge request not found." />
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && titleDraft.trim()) {
                      updateMr.mutate({
                        repoId: repoData?.id ?? "",
                        number: mr.number,
                        title: titleDraft.trim(),
                      });
                      setEditingTitle(false);
                    }
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xl font-semibold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
                <Button
                  size="sm"
                  disabled={!titleDraft.trim() || updateMr.isPending}
                  onClick={() => {
                    if (titleDraft.trim()) {
                      updateMr.mutate({
                        repoId: repoData?.id ?? "",
                        number: mr.number,
                        title: titleDraft.trim(),
                      });
                      setEditingTitle(false);
                    }
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingTitle(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">
                {mr.title}{" "}
                <span className="font-normal text-[var(--color-text-muted)]">
                  #{mr.number}
                </span>
                {isAuthor && (
                  <button
                    type="button"
                    onClick={() => {
                      setTitleDraft(mr.title);
                      setEditingTitle(true);
                    }}
                    className="ml-2 align-middle text-xs text-[var(--color-text-link)] hover:underline"
                  >
                    Edit
                  </button>
                )}
              </h2>
            )}
            <div className="mt-1 flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
              <Badge
                variant={
                  mr.status === "OPEN"
                    ? "success"
                    : mr.status === "MERGED"
                      ? "accent"
                      : "danger"
                }
              >
                {mr.status}
              </Badge>
              <span>{mr.author.name ?? mr.author.email} wants to merge</span>
              <span className="font-medium text-[var(--color-text-primary)]">
                {mr.sourceBranchName}
              </span>
              <span>into</span>
              <span className="font-medium text-[var(--color-text-primary)]">
                {mr.targetBranchName}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="mb-4 flex gap-0 border-b border-[var(--color-border-default)]">
        {(["discussion", "history", "changes"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`relative px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {activeTab === tab && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[var(--color-accent)]" />
            )}
          </button>
        ))}
      </div>

      {activeTab === "discussion" && (
        <DiscussionTab
          mr={mr}
          repoId={repoData?.id ?? ""}
          session={session}
          invalidateMr={invalidateMr}
          router={router}
          orgName={orgName}
          repoName={repoName}
        />
      )}
      {activeTab === "history" && (
        <HistoryTab repoId={repoData?.id ?? ""} mrNumber={mrNumber} />
      )}
      {activeTab === "changes" && (
        <ChangesTab repoId={repoData?.id ?? ""} mrNumber={mrNumber} />
      )}
    </div>
  );
}

// ── Discussion Tab ─────────────────────────────────────────────
function DiscussionTab({
  mr,
  repoId,
  session,
  invalidateMr,
  router,
  orgName,
  repoName,
}: {
  mr: NonNullable<RouterOutputs["mergeRequest"]["get"]>;
  repoId: string;
  session: {
    user?: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  } | null;
  invalidateMr: () => void;
  router: ReturnType<typeof useRouter>;
  orgName: string;
  repoName: string;
}) {
  const [commentBody, setCommentBody] = useState("");
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [commentEditDraft, setCommentEditDraft] = useState("");
  const { issueLink } = useIssueLinker(orgName, repoName);

  // Get org members for reviewer picker
  const { data: orgData } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
    includeUsers: true,
  });
  const members = ((orgData as Record<string, unknown> | undefined)?.users ??
    []) as Array<{
    user: {
      id: string;
      name: string | null;
      email: string;
      image: string | null;
    };
  }>;

  const addComment = api.mergeRequest.addComment.useMutation({
    onSuccess: () => {
      setCommentBody("");
      invalidateMr();
    },
  });
  const deleteComment = api.mergeRequest.deleteComment.useMutation({
    onSuccess: invalidateMr,
  });
  const updateComment = api.mergeRequest.updateComment.useMutation({
    onSuccess: () => {
      setEditingCommentId(null);
      invalidateMr();
    },
  });
  const updateMr = api.mergeRequest.update.useMutation({
    onSuccess: () => {
      setEditingDesc(false);
      invalidateMr();
    },
  });
  const addReview = api.mergeRequest.addReview.useMutation({
    onSuccess: () => {
      setReviewerEmail("");
      invalidateMr();
    },
  });
  const closeMr = api.mergeRequest.close.useMutation({
    onSuccess: invalidateMr,
  });
  const utils = api.useUtils();
  const { data: isSubscribed } = api.mergeRequest.isSubscribed.useQuery(
    { mergeRequestId: mr.id },
    { enabled: !!mr.id },
  );
  const subscribeMut = api.mergeRequest.subscribe.useMutation({
    onSuccess: () => void utils.mergeRequest.isSubscribed.invalidate(),
  });
  const unsubscribeMut = api.mergeRequest.unsubscribe.useMutation({
    onSuccess: () => void utils.mergeRequest.isSubscribed.invalidate(),
  });
  const reopenMr = api.mergeRequest.reopen.useMutation({
    onSuccess: invalidateMr,
  });
  const mergeMr = api.mergeRequest.merge.useMutation({
    onSuccess: () => {
      invalidateMr();
    },
  });

  const currentUserId = session?.user?.id;
  const approvedCount = mr.reviews.filter((r) => r.state === "APPROVED").length;
  const hasRequestChanges = mr.reviews.some(
    (r) => r.state === "REQUEST_CHANGES",
  );
  const requiredReviews = mr.repo?.requiredReviews ?? 0;
  const canMerge =
    mr.status === "OPEN" &&
    !hasRequestChanges &&
    approvedCount >= requiredReviews;

  return (
    <div className="space-y-4">
      {/* Top row: Description + Review sidebar */}
      <div className="flex items-start gap-4">
        {/* Description (left) */}
        <div className="min-w-0 flex-1">
          <Card>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Avatar
                  src={mr.author.image}
                  name={mr.author.name}
                  email={mr.author.email}
                  size="sm"
                />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {mr.author.name ?? mr.author.email}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {new Date(mr.createdAt).toLocaleString()}
                </span>
              </div>
              {currentUserId === mr.authorId && !editingDesc && (
                <button
                  type="button"
                  onClick={() => {
                    setDescDraft(mr.description ?? "");
                    setEditingDesc(true);
                  }}
                  className="text-xs text-[var(--color-text-link)] hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {editingDesc ? (
              <div>
                <textarea
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  placeholder="Description (Markdown supported)"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingDesc(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={updateMr.isPending}
                    onClick={() =>
                      updateMr.mutate({
                        repoId,
                        number: mr.number,
                        description: descDraft,
                      })
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : mr.description ? (
              <MarkdownContent content={mr.description} issueLink={issueLink} />
            ) : (
              <p className="text-sm text-[var(--color-text-muted)] italic">
                No description provided.
              </p>
            )}
          </Card>
        </div>

        {/* Review sidebar (right) */}
        <div className="w-64 shrink-0 space-y-3">
          {/* Reviews list, always visible */}
          <Card>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
              Reviewers
            </h4>
            {mr.reviews.length > 0 ? (
              <div className="space-y-2">
                {mr.reviews.map((review) => {
                  const badge =
                    REVIEW_BADGE[review.state as string] ??
                    REVIEW_BADGE.PENDING!;
                  return (
                    <div
                      key={review.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Avatar
                          src={review.reviewer.image}
                          name={review.reviewer.name}
                          email={review.reviewer.email}
                          size="sm"
                        />
                        <span className="truncate text-xs text-[var(--color-text-primary)]">
                          {review.reviewer.name ?? review.reviewer.email}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {mr.status === "OPEN" && review.state !== "PENDING" && (
                          <button
                            type="button"
                            onClick={() =>
                              addReview.mutate({
                                repoId,
                                mrNumber: mr.number,
                                reviewerId: review.reviewerId,
                                state: "PENDING",
                              })
                            }
                            className="text-[10px] text-[var(--color-text-link)] hover:underline"
                          >
                            Re-request
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)] italic">
                No reviewers yet.
              </p>
            )}
          </Card>

          {/* Request review */}
          {mr.status === "OPEN" && (
            <Card>
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
                Request review
              </h4>
              <select
                value={reviewerEmail}
                onChange={(e) => setReviewerEmail(e.target.value)}
                className="mb-2 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
              >
                <option value="">Select member…</option>
                {members
                  .filter((m) => m.user.id !== mr.authorId)
                  .filter(
                    (m) =>
                      !mr.reviews.some(
                        (r) =>
                          r.reviewerId === m.user.id && r.state === "PENDING",
                      ),
                  )
                  .map((m) => (
                    <option key={m.user.id} value={m.user.id}>
                      {m.user.name ?? m.user.email}
                    </option>
                  ))}
              </select>
              <Button
                size="sm"
                className="w-full"
                disabled={!reviewerEmail || addReview.isPending}
                onClick={() => {
                  if (!reviewerEmail) return;
                  addReview.mutate({
                    repoId,
                    mrNumber: mr.number,
                    reviewerId: reviewerEmail,
                    state: "PENDING",
                  });
                }}
              >
                Request
              </Button>
              {addReview.error && (
                <p className="mt-1 text-[10px] text-[var(--color-danger)]">
                  {addReview.error.message}
                </p>
              )}
            </Card>
          )}

          {/* Submit your review */}
          {mr.status === "OPEN" &&
            currentUserId &&
            currentUserId !== mr.authorId && (
              <Card>
                <h4 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
                  Your review
                </h4>
                <div className="flex flex-col gap-1.5">
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      addReview.mutate({
                        repoId,
                        mrNumber: mr.number,
                        reviewerId: currentUserId,
                        state: "APPROVED",
                      })
                    }
                    disabled={addReview.isPending}
                  >
                    ✓ Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className="w-full"
                    onClick={() =>
                      addReview.mutate({
                        repoId,
                        mrNumber: mr.number,
                        reviewerId: currentUserId,
                        state: "REQUEST_CHANGES",
                      })
                    }
                    disabled={addReview.isPending}
                  >
                    ✗ Request changes
                  </Button>
                </div>
              </Card>
            )}

          {/* Subscription */}
          <Card>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
              Notifications
            </h4>
            <button
              type="button"
              onClick={() => {
                if (!mr) return;
                if (isSubscribed) {
                  unsubscribeMut.mutate({ mergeRequestId: mr.id });
                } else {
                  subscribeMut.mutate({ mergeRequestId: mr.id });
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
                ? "You\u2019re receiving notifications for this MR."
                : "Subscribe to get notified of updates."}
            </p>
          </Card>
        </div>
      </div>

      {/* Comments, full width below */}
      {mr.comments.map((comment) => (
        <Card key={comment.id}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar
                src={comment.author.image}
                name={comment.author.name}
                email={comment.author.email}
                size="sm"
              />
              <span className="text-sm font-medium text-[var(--color-text-primary)]">
                {comment.author.name ?? comment.author.email}
              </span>
              <span className="text-xs text-[var(--color-text-muted)]">
                {new Date(comment.createdAt).toLocaleString()}
              </span>
            </div>
            {comment.authorId === currentUserId && (
              <div className="flex items-center gap-2">
                {editingCommentId !== comment.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCommentId(comment.id);
                      setCommentEditDraft(comment.body);
                    }}
                    className="text-xs text-[var(--color-text-link)] hover:underline"
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Are you sure you want to delete this comment?",
                      )
                    ) {
                      deleteComment.mutate({ commentId: comment.id });
                    }
                  }}
                  className="text-xs text-[var(--color-danger)] hover:underline"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          {editingCommentId === comment.id ? (
            <div>
              <textarea
                autoFocus
                value={commentEditDraft}
                onChange={(e) => setCommentEditDraft(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingCommentId(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!commentEditDraft.trim() || updateComment.isPending}
                  onClick={() =>
                    updateComment.mutate({
                      commentId: comment.id,
                      body: commentEditDraft.trim(),
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <MarkdownContent content={comment.body} issueLink={issueLink} />
          )}
        </Card>
      ))}

      {/* Add comment */}
      <Card>
        <h4 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
          Add a comment
        </h4>
        <textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Leave a comment (Markdown supported)"
          rows={3}
          className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
        />
        <div className="mt-2 flex justify-end gap-2">
          {mr.status === "OPEN" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => closeMr.mutate({ repoId, number: mr.number })}
              disabled={closeMr.isPending}
            >
              Close merge request
            </Button>
          )}
          {mr.status === "CLOSED" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => reopenMr.mutate({ repoId, number: mr.number })}
              disabled={reopenMr.isPending}
            >
              Reopen
            </Button>
          )}
          <Button
            size="sm"
            disabled={!commentBody.trim() || addComment.isPending}
            onClick={() => {
              if (!commentBody.trim()) return;
              addComment.mutate({
                repoId,
                mrNumber: mr.number,
                body: commentBody.trim(),
              });
            }}
          >
            Comment
          </Button>
        </div>
        {addComment.error && (
          <p className="mt-1 text-xs text-[var(--color-danger)]">
            {addComment.error.message}
          </p>
        )}
      </Card>

      {/* Merge area */}
      {mr.status === "OPEN" && (
        <Card
          className={
            canMerge
              ? "border-[var(--color-success)]/30"
              : "border-[var(--color-border-default)]"
          }
        >
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                {canMerge ? "Ready to merge" : "Merge blocked"}
              </h4>
              <p className="text-xs text-[var(--color-text-muted)]">
                {hasRequestChanges
                  ? "Changes have been requested and must be addressed"
                  : approvedCount < requiredReviews
                    ? `${approvedCount} of ${requiredReviews} required approvals`
                    : requiredReviews > 0
                      ? `${approvedCount} approval${approvedCount !== 1 ? "s" : ""}`
                      : "No review requirements"}
              </p>
            </div>
            <Button
              size="sm"
              disabled={!canMerge || mergeMr.isPending}
              onClick={() => mergeMr.mutate({ repoId, number: mr.number })}
            >
              {mergeMr.isPending ? "Merging…" : "Squash and merge"}
            </Button>
          </div>
          {mergeMr.error && (
            <p className="mt-2 text-xs text-[var(--color-danger)]">
              {mergeMr.error.message}
            </p>
          )}
        </Card>
      )}

      {mr.status === "MERGED" && (
        <Card className="border-[var(--color-accent)]/30">
          <p className="text-sm text-[var(--color-text-secondary)]">
            This merge request was merged on{" "}
            <span className="font-medium text-[var(--color-text-primary)]">
              {mr.mergedAt ? new Date(mr.mergedAt).toLocaleString() : "unknown"}
            </span>
            . Branch <span className="font-medium">{mr.sourceBranchName}</span>{" "}
            has been deleted.
          </p>
        </Card>
      )}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────
function HistoryTab({
  repoId,
  mrNumber,
}: {
  repoId: string;
  mrNumber: number;
}) {
  const { data: changelists, isLoading } =
    api.mergeRequest.getChangelists.useQuery(
      { repoId, mrNumber },
      { enabled: !!repoId },
    );

  const [expandedCl, setExpandedCl] = useState<number | null>(null);

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  if (!changelists || changelists.length === 0) {
    return (
      <EmptyState
        title="No changelists"
        description="No changelists found for this merge request."
      />
    );
  }

  return (
    <Card padding={false}>
      <div className="divide-y divide-[var(--color-border-default)]">
        {changelists.map((cl) => (
          <div key={cl.id}>
            <button
              type="button"
              onClick={() =>
                setExpandedCl(expandedCl === cl.number ? null : cl.number)
              }
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-bg-surface)]"
            >
              <Badge variant="accent">CL #{cl.number}</Badge>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]">
                {cl.message.split("\n")[0]}
              </span>
              <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                {cl.user?.email ?? "unknown"}
              </span>
              <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                {new Date(cl.createdAt).toLocaleDateString()}
              </span>
            </button>
            {expandedCl === cl.number && (
              <ExpandedClFiles repoId={repoId} changelistNumber={cl.number} />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ExpandedClFiles({
  repoId,
  changelistNumber,
}: {
  repoId: string;
  changelistNumber: number;
}) {
  const { data: files, isLoading } = api.changelist.getChangelistFiles.useQuery(
    { repoId, changelistNumber },
    { enabled: !!repoId },
  );

  if (isLoading) {
    return (
      <div className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
        Loading files…
      </div>
    );
  }

  if (!files || files.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
        No file changes
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--color-border-muted)] bg-[var(--color-bg-primary)]">
      {files.map((fc) => (
        <div key={fc.id} className="flex items-center gap-2 px-8 py-1">
          <Badge
            variant={FILE_TYPE_COLOR[fc.changeType] ?? "default"}
            className="w-16 justify-center text-center"
          >
            {fc.changeType}
          </Badge>
          <span className="text-xs text-[var(--color-text-primary)]">
            {fc.path ?? fc.fileId}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── File Diff Viewer ─────────────────────────────────────────
function FileDiff({
  repoId,
  filePath,
  fileType,
  sourceHead,
  targetHead,
}: {
  repoId: string;
  filePath: string;
  fileType: string;
  sourceHead: number;
  targetHead: number;
}) {
  // For ADD: no old content. For DELETE: no new content. For MODIFY: both.
  const fetchOld = fileType !== "ADD";
  const fetchNew = fileType !== "DELETE";

  const { data: oldData, isLoading: oldLoading } =
    api.file.readFileContent.useQuery(
      { repoId, changelistNumber: targetHead, filePath },
      { enabled: fetchOld },
    );
  const { data: newData, isLoading: newLoading } =
    api.file.readFileContent.useQuery(
      { repoId, changelistNumber: sourceHead, filePath },
      { enabled: fetchNew },
    );

  const isLoading = (fetchOld && oldLoading) || (fetchNew && newLoading);

  const diffResult = useMemo(() => {
    if (isLoading) return null;
    const oldContent = fetchOld ? (oldData?.content ?? "") : "";
    const newContent = fetchNew ? (newData?.content ?? "") : "";
    if (oldData?.isBinary || newData?.isBinary)
      return { binary: true, lines: [] };
    return { binary: false, parts: diffLines(oldContent, newContent) };
  }, [isLoading, oldData, newData, fetchOld, fetchNew]);

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--color-text-muted)]">
        Loading diff…
      </div>
    );
  }

  if (diffResult?.binary) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--color-text-muted)] italic">
        Binary file, diff not available
      </div>
    );
  }

  if (!diffResult?.parts) return null;

  // Build line-numbered diff lines
  const lines: {
    type: "add" | "remove" | "context";
    oldNum?: number;
    newNum?: number;
    text: string;
  }[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffResult.parts) {
    const partLines = part.value.replace(/\n$/, "").split("\n");
    for (const text of partLines) {
      if (part.added) {
        lines.push({ type: "add", newNum: newLine++, text });
      } else if (part.removed) {
        lines.push({ type: "remove", oldNum: oldLine++, text });
      } else {
        lines.push({
          type: "context",
          oldNum: oldLine++,
          newNum: newLine++,
          text,
        });
      }
    }
  }

  // Collapse context lines far from changes: show 3 lines around each add/remove
  const CONTEXT = 3;
  const changeIndices = new Set<number>();
  lines.forEach((l, i) => {
    if (l.type !== "context") {
      for (
        let j = Math.max(0, i - CONTEXT);
        j <= Math.min(lines.length - 1, i + CONTEXT);
        j++
      ) {
        changeIndices.add(j);
      }
    }
  });

  const rendered: React.ReactNode[] = [];
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!changeIndices.has(i)) continue;
    if (lastIdx !== -1 && i - lastIdx > 1) {
      rendered.push(
        <div
          key={`sep-${i}`}
          className="flex border-y border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
        >
          ⋯ {i - lastIdx - 1} lines hidden
        </div>,
      );
    }
    const line = lines[i]!;
    const bg =
      line.type === "add"
        ? "bg-[rgba(63,185,80,0.1)]"
        : line.type === "remove"
          ? "bg-[rgba(248,81,73,0.1)]"
          : "";
    const lineNumColor = "text-[var(--color-text-muted)]";
    rendered.push(
      <div key={i} className={`flex font-mono text-xs leading-5 ${bg}`}>
        <span
          className={`w-10 shrink-0 pr-2 text-right select-none ${lineNumColor}`}
        >
          {line.oldNum ?? ""}
        </span>
        <span
          className={`w-10 shrink-0 pr-2 text-right select-none ${lineNumColor}`}
        >
          {line.newNum ?? ""}
        </span>
        <span className="w-4 shrink-0 text-center text-[var(--color-text-muted)] select-none">
          {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
        </span>
        <span className="min-w-0 pr-2 break-all whitespace-pre-wrap text-[var(--color-text-primary)]">
          {line.text || " "}
        </span>
      </div>,
    );
    lastIdx = i;
  }

  if (rendered.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--color-text-muted)] italic">
        No differences
      </div>
    );
  }

  return (
    <div className="max-h-[600px] overflow-auto border-t border-[var(--color-border-muted)] bg-[var(--color-bg-primary)]">
      {rendered}
    </div>
  );
}

// ── Changes Tab ──────────────────────────────────────────────
function ChangesTab({
  repoId,
  mrNumber,
}: {
  repoId: string;
  mrNumber: number;
}) {
  const { data, isLoading } = api.mergeRequest.getChangedFiles.useQuery(
    { repoId, mrNumber },
    { enabled: !!repoId },
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    );
  }

  if (!data || data.files.length === 0) {
    return (
      <EmptyState
        title="No changes"
        description="No file changes found for this merge request."
      />
    );
  }

  const { files, sourceHead, targetHead } = data;

  const toggleFile = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="space-y-0.5">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs text-[var(--color-text-muted)]">
          {files.length} file{files.length !== 1 ? "s" : ""} changed
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setExpanded(new Set(files.map((f) => f.path)))}
            className="text-xs text-[var(--color-text-link)] hover:underline"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setExpanded(new Set())}
            className="text-xs text-[var(--color-text-link)] hover:underline"
          >
            Collapse all
          </button>
        </div>
      </div>
      {files.map((file) => {
        const isExpanded = expanded.has(file.path);
        return (
          <Card key={file.path} padding={false}>
            <button
              type="button"
              onClick={() => toggleFile(file.path)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-secondary)]"
            >
              <span className="text-xs text-[var(--color-text-muted)]">
                {isExpanded ? "▼" : "▶"}
              </span>
              <Badge
                variant={FILE_TYPE_COLOR[file.type] ?? "default"}
                className="w-16 justify-center text-center"
              >
                {file.type}
              </Badge>
              <span className="min-w-0 truncate text-sm text-[var(--color-text-primary)]">
                {file.path}
              </span>
            </button>
            {isExpanded && (
              <FileDiff
                repoId={repoId}
                filePath={file.path}
                fileType={file.type}
                sourceHead={sourceHead}
                targetHead={targetHead}
              />
            )}
          </Card>
        );
      })}
    </div>
  );
}
