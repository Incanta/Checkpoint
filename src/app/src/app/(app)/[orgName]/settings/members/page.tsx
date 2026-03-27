"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader, Badge, Avatar, Tabs, Tab } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const ROLE_COLORS = {
  ADMIN: "accent" as const,
  BILLING: "warning" as const,
  MEMBER: "default" as const,
};

export default function OrgMembersPage() {
  const params = useParams<{ orgName: string }>();
  const orgName = decodeURIComponent(params.orgName);
  useDocumentTitle(`Members · ${orgName}`);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const utils = api.useUtils();

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
    includeUsers: true,
  });

  const addUser = api.org.addUserToOrg.useMutation({
    onSuccess: () => {
      setNewEmail("");
      void utils.org.getOrg.invalidate();
    },
  });

  const members = (org as any)?.users ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`${orgName} members`}
        breadcrumbs={
          <span>
            <a href={`/${orgName}`} className="text-[var(--color-info)] hover:underline">
              {orgName}
            </a>
            {" / Settings / Members"}
          </span>
        }
      />

      <Tabs className="mb-6">
        <Tab href={`/${orgName}/settings`} exact>
          General
        </Tab>
        <Tab href={`/${orgName}/settings/members`}>Members</Tab>
      </Tabs>

      <div className="space-y-6">
        {/* Add member form */}
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
            Add a member
          </h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newEmail.trim() && org) {
                addUser.mutate({
                  orgId: org.id,
                  userEmail: newEmail.trim(),
                  role: newRole,
                });
              }
            }}
            className="flex flex-wrap gap-2"
          >
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as "MEMBER" | "ADMIN")}
              className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none"
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
            <Button type="submit" size="sm" disabled={!newEmail.trim() || addUser.isPending}>
              {addUser.isPending ? "Adding..." : "Add"}
            </Button>
          </form>
          {addUser.error && (
            <p className="mt-2 text-sm text-[var(--color-danger)]">{addUser.error.message}</p>
          )}
        </Card>

        {/* Member list */}
        <Card padding={false}>
          <div className="divide-y divide-[var(--color-border-default)]">
            {members.map((member: any) => (
              <div
                key={member.user.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <Avatar
                    src={member.user.image}
                    name={member.user.name}
                    email={member.user.email}
                    size="sm"
                  />
                  <div>
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">
                      {member.user.name ?? member.user.email}
                    </div>
                    {member.user.name && (
                      <div className="text-xs text-[var(--color-text-secondary)]">
                        {member.user.email}
                      </div>
                    )}
                  </div>
                </div>
                <Badge variant={ROLE_COLORS[member.role as keyof typeof ROLE_COLORS] ?? "default"}>
                  {member.role}
                </Badge>
              </div>
            ))}
            {members.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
                No members found.
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
