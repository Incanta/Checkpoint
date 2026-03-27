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

export function AppHeader() {
  const { data: user } = api.user.me.useQuery();
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
