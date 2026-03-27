"use client";

import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import { Avatar, Button, Card, PageHeader } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2 MB
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export default function UserSettingsPage() {
  useDocumentTitle("Settings · Checkpoint VCS");
  const { data: user } = api.user.me.useQuery();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize form when user data loads
  if (user && !initialized) {
    setName(user.name ?? "");
    setUsername(user.username ?? "");
    setInitialized(true);
  }

  const utils = api.useUtils();
  const updateUser = api.user.updateUser.useMutation({
    onSuccess: () => {
      void utils.user.me.invalidate();
    },
  });

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAvatarError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setAvatarError("Please upload a PNG, JPEG, GIF, or WebP image.");
      return;
    }
    if (file.size > MAX_AVATAR_SIZE) {
      setAvatarError("Image must be smaller than 2 MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (!user) return;
      updateUser.mutate({ id: user.id, image: reader.result as string });
    };
    reader.readAsDataURL(file);

    // Reset so re-selecting the same file still triggers onChange
    e.target.value = "";
  };

  const handleRemoveAvatar = () => {
    if (!user) return;
    setAvatarError(null);
    updateUser.mutate({ id: user.id, image: null });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    updateUser.mutate({
      id: user.id,
      name: name.trim() || undefined,
      username: username.trim() || undefined,
    });
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="Profile settings"
        description="Manage your account information."
      />

      {/* Avatar section */}
      <Card>
        <div className="flex items-center gap-4">
          <Avatar
            src={user?.image}
            name={user?.name}
            email={user?.email}
            size="lg"
          />
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              Profile picture
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                onChange={handleAvatarChange}
                className="hidden"
              />
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={updateUser.isPending}
              >
                Upload image
              </Button>
              {user?.image && (
                <button
                  type="button"
                  onClick={handleRemoveAvatar}
                  disabled={updateUser.isPending}
                  className="text-sm text-[var(--color-danger)] hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            {avatarError && (
              <p className="text-sm text-[var(--color-danger)]">
                {avatarError}
              </p>
            )}
            <p className="text-xs text-[var(--color-text-muted)]">
              PNG, JPEG, GIF, or WebP. Max 2 MB.
            </p>
          </div>
        </div>
      </Card>

      <div className="mt-4" />

      <Card>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
              Email
            </label>
            <input
              type="text"
              value={user?.email ?? ""}
              disabled
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-sm text-[var(--color-text-secondary)]"
            />
          </div>

          <div>
            <label
              htmlFor="user-name"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Display name
            </label>
            <input
              id="user-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          <div>
            <label
              htmlFor="user-username"
              className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Username
            </label>
            <input
              id="user-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          {updateUser.error && (
            <p className="text-sm text-[var(--color-danger)]">
              {updateUser.error.message}
            </p>
          )}
          {updateUser.isSuccess && (
            <p className="text-sm text-[var(--color-success)]">
              Profile updated successfully.
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={updateUser.isPending}>
              {updateUser.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
