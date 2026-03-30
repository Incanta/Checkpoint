"use client";

import Link from "next/link";
import Image from "next/image";
import { Avatar } from "~/app/_components/ui/avatar";
import {
  Dropdown,
  DropdownItem,
  DropdownDivider,
} from "~/app/_components/ui/dropdown";
import { authClient } from "~/lib/auth-client";
import { useTheme } from "~/app/_components/theme-provider";
import { api } from "~/trpc/react";

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11ZM8 0a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 0ZM3.05 3.05a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 0 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06Zm9.19.7a.75.75 0 0 0-1.06-1.06l-.7.7a.75.75 0 0 0 1.06 1.06l.7-.7ZM0 8a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1A.75.75 0 0 1 0 8Zm14.25-.75a.75.75 0 0 1 0 1.5h-1a.75.75 0 0 1 0-1.5h1Zm-11.2 4.45a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 0 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06Zm8.34.7a.75.75 0 0 0-1.06-1.06l-.7.7a.75.75 0 0 0 1.06 1.06l.7-.7ZM8 14.25a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 14.25Z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.598 1.591a.749.749 0 0 1 .785.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.136Z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 16a2 2 0 0 0 1.985-1.75H6.015A2 2 0 0 0 8 16ZM8 1.5A3.5 3.5 0 0 0 4.5 5c0 .847-.235 2.58-.632 3.853-.193.619-.415 1.136-.654 1.466-.126.174-.236.271-.314.32H13.1a1.76 1.76 0 0 1-.314-.32c-.239-.33-.461-.847-.654-1.466C11.735 7.58 11.5 5.847 11.5 5A3.5 3.5 0 0 0 8 1.5ZM3 5c0-2.76 2.24-5 5-5s5 2.24 5 5c0 .857.222 2.476.597 3.674.186.595.409 1.12.674 1.518.253.38.64.808 1.229.808a1 1 0 0 1 0 2H.5a1 1 0 0 1 0-2c.59 0 .976-.428 1.229-.808.265-.398.488-.923.674-1.518C2.778 7.476 3 5.857 3 5Z" />
    </svg>
  );
}

function timeAgo(dateStr: string) {
  const now = Date.now();
  const d = new Date(dateStr).getTime();
  const seconds = Math.floor((now - d) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function AppHeader() {
  const { data: user } = api.user.me.useQuery();
  const { data: unreadCount } = api.notification.countUnread.useQuery(
    undefined,
    {
      refetchInterval: 30_000,
    },
  );
  const { data: notifs } = api.notification.list.useQuery(
    { limit: 10 },
    { refetchInterval: 30_000 },
  );
  const utils = api.useUtils();
  const markRead = api.notification.markRead.useMutation({
    onSuccess: () => {
      void utils.notification.countUnread.invalidate();
      void utils.notification.list.invalidate();
    },
  });
  const markAllRead = api.notification.markAllRead.useMutation({
    onSuccess: () => {
      void utils.notification.countUnread.invalidate();
      void utils.notification.list.invalidate();
    },
  });
  const { theme, toggle } = useTheme();

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/signin";
        },
      },
    });
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-4">
      {/* Left side: logo */}
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold text-[var(--color-text-primary)] no-underline"
        >
          <Image
            src="/checkpoint-logo.svg"
            alt="CheckpointVCS Logo"
            width={24}
            height={24}
            className="h-6 w-6"
          />
          <span>
            Checkpoint<span className="text-[var(--color-accent)]">VCS</span>
          </span>
        </Link>
      </div>

      {/* Right side: create + avatar */}
      <div className="flex items-center gap-2">
        {/* Create dropdown */}
        <Dropdown
          trigger={
            <span className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]">
              <PlusIcon />
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                fill="currentColor"
                className="ml-0.5"
              >
                <path
                  d="M1 2.5L4 5.5L7 2.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                />
              </svg>
            </span>
          }
        >
          <DropdownItem href="/new/org">New organization</DropdownItem>
          <DropdownItem href="/new/repo">New repository</DropdownItem>
        </Dropdown>

        {/* Notifications bell */}
        <Dropdown
          trigger={
            <span className="relative flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]">
              <BellIcon />
              {(unreadCount ?? 0) > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold text-white">
                  {unreadCount! > 99 ? "99+" : unreadCount}
                </span>
              )}
            </span>
          }
        >
          <div className="w-80">
            <div className="flex items-center justify-between px-4 py-2">
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                Notifications
              </span>
              {(unreadCount ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => markAllRead.mutate()}
                  className="text-xs text-[var(--color-text-link)] hover:underline"
                >
                  Mark all read
                </button>
              )}
            </div>
            <DropdownDivider />
            {notifs?.items && notifs.items.length > 0 ? (
              <div className="max-h-80 overflow-y-auto">
                {notifs.items.map((n) => (
                  <DropdownItem
                    key={n.id}
                    href={n.link}
                    onClick={() => {
                      if (!n.read) markRead.mutate({ id: n.id });
                    }}
                  >
                    <div className="flex gap-2">
                      {!n.read && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />
                      )}
                      <div className={!n.read ? "" : "pl-4"}>
                        <div className="line-clamp-2 text-xs font-medium text-[var(--color-text-primary)]">
                          {n.title}
                        </div>
                        {n.body && (
                          <div className="mt-0.5 line-clamp-1 text-[11px] text-[var(--color-text-muted)]">
                            {n.body}
                          </div>
                        )}
                        <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                          {n.actor?.name ?? n.actor?.email ?? ""} ·{" "}
                          {timeAgo(n.createdAt.toString())}
                        </div>
                      </div>
                    </div>
                  </DropdownItem>
                ))}
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
                No notifications yet
              </div>
            )}
          </div>
        </Dropdown>

        {/* User avatar dropdown */}
        <Dropdown
          trigger={
            <Avatar
              src={user?.image}
              name={user?.name}
              email={user?.email}
              size="md"
              className="cursor-pointer ring-2 ring-transparent transition-all hover:ring-[var(--color-border-default)]"
            />
          }
        >
          <div className="px-4 py-2 text-sm">
            <div className="font-medium text-[var(--color-text-primary)]">
              {user?.name ?? user?.email}
            </div>
            {user?.name && (
              <div className="text-[var(--color-text-secondary)]">
                {user.email}
              </div>
            )}
          </div>
          <DropdownDivider />
          <DropdownItem href="/settings">Profile & Settings</DropdownItem>
          <DropdownItem href="/settings/devices">Devices & Tokens</DropdownItem>
          <DropdownDivider />
          <DropdownItem onClick={toggle}>
            <span className="flex items-center gap-2">
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
          </DropdownItem>
          <DropdownDivider />
          <DropdownItem onClick={handleSignOut} danger>
            Sign out
          </DropdownItem>
        </Dropdown>
      </div>
    </header>
  );
}
