import Link from "next/link";
import { redirect } from "next/navigation";

import { CheckpointHome } from "~/app/_components/checkpoint-home";
import { auth } from "~/server/auth";
import { api, HydrateClient } from "~/trpc/server";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <HydrateClient>
        <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
          <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
            <h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">
              Checkpoint<span className="text-[hsl(280,100%,70%)]">VCS</span>
            </h1>
            <div className="flex flex-col items-center gap-4">
              <p className="text-xl">
                Please sign in to access your organizations and repositories
              </p>
              <div className="flex gap-4">
                <Link
                  href="/signin"
                  className="rounded-full bg-white/10 px-10 py-3 font-semibold no-underline transition hover:bg-white/20"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </main>
      </HydrateClient>
    );
  }

  // Prefetch user data
  try {
    await api.user.me();
    await api.org.myOrgs();
  } catch (error) {
    // If user doesn't exist in Checkpoint, redirect to sign in
    console.error("User not found in Checkpoint system:", error);
    redirect("/api/auth/signin");
  }

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
        <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
          <div className="flex w-full max-w-4xl items-center justify-between">
            <h1 className="text-3xl font-bold">
              Checkpoint<span className="text-[hsl(280,100%,70%)]">VCS</span>
            </h1>
            <Link
              href="/api/auth/signout"
              className="rounded-full bg-white/10 px-6 py-2 font-semibold no-underline transition hover:bg-white/20"
            >
              Sign out
            </Link>
          </div>

          <CheckpointHome />
        </div>
      </main>
    </HydrateClient>
  );
}
