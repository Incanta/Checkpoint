"use client";

import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { PageHeader, Tabs, Tab } from "~/app/_components/ui";

export default function RepoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ orgName: string; repoName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const basePath = `/${orgName}/${repoName}`;

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });

  // Find the repo from the org's repos list
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <a
              href={`/${orgName}`}
              className="text-[var(--color-info)] hover:underline"
            >
              {orgName}
            </a>
            <span className="text-[var(--color-text-muted)]">/</span>
            <span>{repoName}</span>
          </span>
        }
      />

      <Tabs className="mb-6">
        <Tab href={basePath} exact>
          Files
        </Tab>
        <Tab href={`${basePath}/history`}>History</Tab>
        <Tab href={`${basePath}/branches`}>Branches</Tab>
        <Tab href={`${basePath}/labels`}>Labels</Tab>
        <Tab href={`${basePath}/settings`}>Settings</Tab>
      </Tabs>

      {children}
    </div>
  );
}
