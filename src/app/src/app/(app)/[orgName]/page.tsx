"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import {
  Card,
  PageHeader,
  Badge,
  EmptyState,
  Button,
} from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function RepoSize({ repoId }: { repoId: string }) {
  const { data } = api.storage.getRepoSize.useQuery(
    { repoId },
    { staleTime: 60_000 },
  );

  if (data == null) return null;

  return (
    <span className="text-xs text-[var(--color-text-muted)]">
      {formatSize(data.size)}
    </span>
  );
}

export default function OrgPage() {
  const params = useParams<{ orgName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  useDocumentTitle(`${orgName} · Checkpoint VCS`);

  const { data: org, isLoading } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
    includeUsers: true,
  });
  const { data: repos } = api.repo.list.useQuery(
    { orgId: org?.id ?? "" },
    { enabled: !!org?.id },
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="h-8 w-48 animate-pulse rounded bg-[var(--color-bg-secondary)]" />
        <div className="mt-6 space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg bg-[var(--color-bg-secondary)]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <EmptyState
        title="Organization not found"
        description={`The organization "${orgName}" doesn't exist or you don't have access.`}
        action={
          <Link href="/">
            <Button variant="secondary">Back to dashboard</Button>
          </Link>
        }
      />
    );
  }

  const orgUsers = org.users;

  const isAdmin = orgUsers?.some((u: { role: string }) => u.role === "ADMIN");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {org.name}
            {orgUsers && (
              <Badge>
                {orgUsers.length} member{orgUsers.length !== 1 ? "s" : ""}
              </Badge>
            )}
          </span>
        }
        actions={
          <div className="flex gap-2">
            {isAdmin && (
              <Link href={`/${orgName}/settings`}>
                <Button variant="ghost" size="sm">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.1-.303c.652-.18 1.34.03 1.74.546a8.014 8.014 0 0 1 1.081 1.876c.238.608.093 1.308-.36 1.74l-.826.79a.272.272 0 0 0-.064.294c.05.2.084.406.103.618a.28.28 0 0 0 .1.273l.852.777c.464.423.624 1.12.4 1.735a7.98 7.98 0 0 1-1.054 1.89c-.39.524-1.075.748-1.734.583l-1.12-.307a.278.278 0 0 0-.298.07 4.452 4.452 0 0 1-.663.382.267.267 0 0 0-.212.224l-.292 1.118c-.17.652-.718 1.206-1.459 1.27A8.394 8.394 0 0 1 8 16a8.394 8.394 0 0 1-.701-.031c-.74-.064-1.289-.618-1.459-1.27l-.292-1.118a.267.267 0 0 0-.212-.224 4.452 4.452 0 0 1-.663-.382.278.278 0 0 0-.298-.07l-1.12.307c-.659.165-1.344-.059-1.734-.583a7.98 7.98 0 0 1-1.054-1.89c-.224-.615-.064-1.312.4-1.735l.852-.777a.28.28 0 0 0 .1-.273 4.1 4.1 0 0 1 .103-.618.272.272 0 0 0-.064-.294l-.826-.79c-.453-.432-.598-1.132-.36-1.74a8.014 8.014 0 0 1 1.08-1.876c.4-.516 1.089-.726 1.741-.546l1.1.303c.066.019.176.011.299-.071.214-.143.437-.272.668-.386.133-.066.194-.158.212-.224L5.84 1.29c.17-.645.716-1.195 1.459-1.26A8.394 8.394 0 0 1 8 0ZM5.5 8a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0Z" />
                  </svg>
                  Settings
                </Button>
              </Link>
            )}
            <Link href={`/new/repo?org=${orgName}`}>
              <Button variant="primary" size="sm">
                New repository
              </Button>
            </Link>
          </div>
        }
      />

      {/* Repo list */}
      {repos && repos.length > 0 ? (
        <div className="space-y-2">
          {repos.map((repo) => (
            <Link
              key={repo.id}
              href={`/${orgName}/${repo.name}`}
              className="block no-underline"
            >
              <Card className="transition-colors hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-surface)]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className="text-[var(--color-text-muted)]"
                    >
                      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
                    </svg>
                    <span className="font-medium text-[var(--color-text-primary)]">
                      {repo.name}
                    </span>
                    {repo.public && <Badge variant="info">Public</Badge>}
                  </div>
                  <RepoSize repoId={repo.id} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No repositories yet"
          description="Create your first repository to start tracking files."
          action={
            <Link href={`/new/repo?org=${orgName}`}>
              <Button variant="primary">New repository</Button>
            </Link>
          }
        />
      )}
    </div>
  );
}
