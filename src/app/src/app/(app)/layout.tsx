import { redirect } from "next/navigation";
import { getSession } from "~/server/auth";
import { db } from "~/server/db";
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

  // Redirect admin to initial setup if EULA has not been accepted
  const currentUser = await db.user.findUnique({
    where: { id: session.user.id },
    select: { checkpointAdmin: true },
  });
  if (currentUser?.checkpointAdmin) {
    const instanceSettings = await db.instanceSettings.findUnique({
      where: { id: "default" },
    });
    if (!instanceSettings?.eulaAcceptedAt) {
      redirect("/setup");
    }
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
