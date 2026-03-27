"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useMemo } from "react";
import { api } from "~/trpc/react";

function RepoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 text-[var(--color-text-muted)]"
    >
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
    </svg>
  );
}

function OrgIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 text-[var(--color-text-muted)]"
    >
      <path d="M1.75 16A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .085-.006.168-.018.25h2.268a.25.25 0 0 0 .25-.25V8.285a.25.25 0 0 0-.111-.208l-1.055-.703a.749.749 0 1 1 .832-1.248l1.64 1.093c.228.152.364.41.364.69v6.341A1.75 1.75 0 0 1 14.25 16Zm-.25-1.75c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25ZM3.75 6h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 3.75A.75.75 0 0 1 3.75 3h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 3.75Zm4 3A.75.75 0 0 1 7.75 6h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 7 6.75ZM7.75 3h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 9.75A.75.75 0 0 1 3.75 9h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 9.75ZM7.75 9h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5Z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="text-[var(--color-text-muted)]"
    >
      <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
    </svg>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const [filter, setFilter] = useState("");
  const { data: orgs } = api.org.myOrgs.useQuery();

  const filtered = useMemo(() => {
    if (!orgs) return [];
    const q = filter.toLowerCase();
    if (!q) return orgs;
    return orgs
      .map((org) => ({
        ...org,
        repos: org.repos.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            org.name.toLowerCase().includes(q),
        ),
      }))
      .filter(
        (org) => org.repos.length > 0 || org.name.toLowerCase().includes(q),
      );
  }, [orgs, filter]);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
      {/* Search */}
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5">
          <SearchIcon />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a repository..."
            className="w-full bg-transparent text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none"
          />
        </div>
      </div>

      {/* Org/repo tree */}
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {filtered?.map((org) => (
          <div key={org.id} className="mb-1">
            <Link
              href={`/${org.name}`}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium no-underline transition-colors ${
                pathname === `/${org.name}`
                  ? "bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              <OrgIcon />
              <span className="truncate">{org.name}</span>
            </Link>

            {org.repos.length > 0 && (
              <div className="ml-3 border-l border-[var(--color-border-muted)] pl-2">
                {org.repos.map((repo) => {
                  const repoPath = `/${org.name}/${repo.name}`;
                  const pathnameThroughRepo = pathname
                    .split("/")
                    .slice(0, 3)
                    .join("/");
                  const isActive = pathnameThroughRepo === repoPath;
                  return (
                    <Link
                      key={repo.id}
                      href={repoPath}
                      className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm no-underline transition-colors ${
                        isActive
                          ? "bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]"
                          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                      }`}
                    >
                      <RepoIcon />
                      <span className="truncate">{repo.name}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {filtered?.length === 0 && (
          <p className="px-2 py-4 text-center text-sm text-[var(--color-text-muted)]">
            {filter ? "No matches" : "No organizations yet"}
          </p>
        )}
      </nav>
    </aside>
  );
}
