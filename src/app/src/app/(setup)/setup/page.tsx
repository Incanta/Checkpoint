import { redirect } from "next/navigation";
import { getSession } from "~/server/auth";
import { db } from "~/server/db";
import { SetupForm } from "./setup-form";

export default async function SetupPage() {
  const session = await getSession();
  if (!session?.user) {
    redirect("/signin");
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { checkpointAdmin: true },
  });

  if (!user?.checkpointAdmin) {
    redirect("/");
  }

  const settings = await db.instanceSettings.findUnique({
    where: { id: "default" },
  });

  if (settings?.eulaAcceptedAt) {
    redirect("/");
  }

  return <SetupForm />;
}
