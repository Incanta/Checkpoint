"use client";

import { useState } from "react";
import { api } from "~/trpc/react";

export function CheckpointHome() {
  const [newOrgName, setNewOrgName] = useState("");
  const [newRepoNames, setNewRepoNames] = useState<Record<string, string>>({});

  // Get user data
  const {
    data: user,
    isLoading: userLoading,
    error: userError,
  } = api.user.me.useQuery();

  // Get user's organizations
  const {
    data: orgs,
    isLoading: orgsLoading,
    error: orgsError,
  } = api.org.myOrgs.useQuery();

  // Filer token query (disabled until triggered)
  const filerTokenQuery = api.storage.getFilerToken.useQuery(undefined, {
    enabled: false,
  });

  // Mutations
  const createOrgMutation = api.org.createOrg.useMutation({
    onSuccess: () => {
      setNewOrgName("");
      // Refetch orgs
      void utils.org.myOrgs.invalidate();
    },
  });

  const createRepoMutation = api.repo.createRepo.useMutation({
    onSuccess: () => {
      setNewRepoNames({});
      // Refetch orgs to get updated repo lists
      void utils.org.myOrgs.invalidate();
    },
  });

  const utils = api.useUtils();

  const handleOpenFiler = async () => {
    const result = await filerTokenQuery.refetch();
    if (result.data) {
      const { token, filerUrl } = result.data;
      const domain = new URL(filerUrl).hostname;
      document.cookie = `AT=${token}; domain=${domain}; path=/; max-age=${30 * 24 * 60 * 60}`;
      window.open(filerUrl, "_blank");
    }
  };

  if (userLoading || orgsLoading) {
    return <div className="text-white">Loading...</div>;
  }

  if (userError || orgsError) {
    return (
      <div className="text-red-400">
        Error: {userError?.message || orgsError?.message}
      </div>
    );
  }

  const handleCreateOrg = (e: React.FormEvent) => {
    e.preventDefault();
    if (newOrgName.trim()) {
      createOrgMutation.mutate({ name: newOrgName.trim() });
    }
  };

  const handleCreateRepo = (orgId: string) => {
    const repoName = newRepoNames[orgId];
    if (repoName?.trim()) {
      createRepoMutation.mutate({
        name: repoName.trim(),
        orgId,
      });
    }
  };

  const updateRepoName = (orgId: string, name: string) => {
    setNewRepoNames((prev) => ({
      ...prev,
      [orgId]: name,
    }));
  };

  return (
    <div className="w-full max-w-4xl space-y-8">
      {/* User Info */}
      <div className="rounded-lg bg-white/10 p-6">
        <p className="text-xl">
          Logged in as <span className="font-semibold">{user?.email}</span>
        </p>
      </div>

      {/* Dev: Open Filer */}
      <div className="rounded-lg bg-white/10 p-6">
        <button
          type="button"
          onClick={() => void handleOpenFiler()}
          disabled={filerTokenQuery.isFetching}
          className="rounded-full bg-[hsl(200,100%,50%)] px-6 py-2 font-semibold text-white transition hover:bg-[hsl(200,100%,40%)] disabled:opacity-50"
        >
          {filerTokenQuery.isFetching ? "Loading..." : "Open Filer"}
        </button>
      </div>

      {/* Create Organization Form */}
      <div className="rounded-lg bg-white/10 p-6">
        <h2 className="mb-4 text-xl font-semibold">Create Organization</h2>
        <form onSubmit={handleCreateOrg} className="flex gap-4">
          <input
            type="text"
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            placeholder="New organization name"
            className="flex-1 rounded-full bg-white/10 px-4 py-2 text-white placeholder-white/50 focus:ring-2 focus:ring-white/20 focus:outline-none"
          />
          <button
            type="submit"
            disabled={createOrgMutation.isPending || !newOrgName.trim()}
            className="rounded-full bg-[hsl(280,100%,70%)] px-6 py-2 font-semibold text-white transition hover:bg-[hsl(280,100%,60%)] disabled:opacity-50"
          >
            {createOrgMutation.isPending ? "Creating..." : "Create Org"}
          </button>
        </form>
      </div>

      {/* Organizations List */}
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold">Organizations</h2>
        {orgs && orgs.length > 0 ? (
          <div className="space-y-4">
            {orgs.map((org) => (
              <div key={org.id} className="rounded-lg bg-white/10 p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-xl font-semibold">
                    {org.name}{" "}
                    <span className="text-sm font-normal text-white/70">
                      ({org.id})
                    </span>
                  </h3>
                </div>

                {/* Create Repository Form */}
                <div className="mb-4">
                  <h4 className="mb-2 text-lg font-medium">
                    Create Repository
                  </h4>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleCreateRepo(org.id);
                    }}
                    className="flex gap-4"
                  >
                    <input
                      type="text"
                      value={newRepoNames[org.id] || ""}
                      onChange={(e) => updateRepoName(org.id, e.target.value)}
                      placeholder="New repository name"
                      className="flex-1 rounded-full bg-white/10 px-4 py-2 text-white placeholder-white/50 focus:ring-2 focus:ring-white/20 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={
                        createRepoMutation.isPending ||
                        !newRepoNames[org.id]?.trim()
                      }
                      className="rounded-full bg-[hsl(280,100%,70%)] px-6 py-2 font-semibold text-white transition hover:bg-[hsl(280,100%,60%)] disabled:opacity-50"
                    >
                      {createRepoMutation.isPending
                        ? "Creating..."
                        : "Create Repo"}
                    </button>
                  </form>
                </div>

                {/* Repositories List */}
                <div>
                  <h4 className="mb-2 text-lg font-medium">Repositories</h4>
                  {org.repos && org.repos.length > 0 ? (
                    <ul className="space-y-2">
                      {org.repos.map((repo) => (
                        <li
                          key={repo.id}
                          className="rounded bg-white/5 px-4 py-2"
                        >
                          <span className="font-medium">{repo.name}</span>
                          <span className="ml-2 text-sm text-white/70">
                            ({repo.id})
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-white/70">No repositories yet.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-white/10 p-6 text-center">
            <p className="text-white/70">
              You are not a member of any organizations yet.
            </p>
            <p className="text-white/70">
              Create your first organization above to get started.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
