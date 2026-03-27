import { redirect } from "next/navigation";
import { getSession } from "~/server/auth";
import { api, HydrateClient } from "~/trpc/server";
import { AppShell } from "~/app/_components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/signin");
  }

  // Prefetch user and orgs for sidebar/header
  try {
    await api.user.me();
    await api.org.myOrgs();
  } catch {
    redirect("/signin");
  }

  return (
    <HydrateClient>
      <AppShell>{children}</AppShell>
    </HydrateClient>
  );
}
