"use client";

import Link from "next/link";
import { api } from "~/trpc/react";
import { Card, PageHeader, Badge, EmptyState, Button } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

function RepoCard({
  orgName,
  repo,
}: {
  orgName: string;
  repo: { id: string; name: string; public?: boolean };
}) {
  return (
    <Link
      href={`/${orgName}/${repo.name}`}
      className="block no-underline"
    >
      <Card className="transition-colors hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-surface)]">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-[var(--color-text-muted)]">
            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
          </svg>
          <span className="font-medium text-[var(--color-text-primary)]">
            {orgName}/{repo.name}
          </span>
          {repo.public && <Badge variant="info">Public</Badge>}
        </div>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  useDocumentTitle("Checkpoint VCS");
  const { data: user } = api.user.me.useQuery();
  const { data: orgs, isLoading } = api.org.myOrgs.useQuery();

  const allRepos =
    orgs?.flatMap((org) =>
      org.repos.map((repo) => ({ ...repo, orgName: org.name })),
    ) ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={
          <>
            Welcome back
            {user?.name ? (
              <span className="text-[var(--color-text-secondary)]">
                , {user.name}
              </span>
            ) : null}
          </>
        }
        description="Your organizations and repositories"
      />

      {/* Quick stats */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-2xl font-bold text-[var(--color-text-primary)]">
            {orgs?.length ?? 0}
          </div>
          <div className="text-sm text-[var(--color-text-secondary)]">
            Organizations
          </div>
        </Card>
        <Card>
          <div className="text-2xl font-bold text-[var(--color-text-primary)]">
            {allRepos.length}
          </div>
          <div className="text-sm text-[var(--color-text-secondary)]">
            Repositories
          </div>
        </Card>
      </div>

      {/* Repositories */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
          Repositories
        </h2>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-lg bg-[var(--color-bg-secondary)]"
              />
            ))}
          </div>
        ) : allRepos.length > 0 ? (
          <div className="space-y-2">
            {allRepos.map((repo) => (
              <RepoCard
                key={repo.id}
                orgName={repo.orgName}
                repo={repo}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No repositories yet"
            description="Create an organization and repository to get started."
            action={
              <div className="flex gap-2">
                <Link href="/new/org">
                  <Button variant="primary" size="md">
                    Create organization
                  </Button>
                </Link>
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
