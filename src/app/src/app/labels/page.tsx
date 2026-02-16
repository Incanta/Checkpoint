import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "~/server/auth";
import { LabelsView } from "./_components/labels-view";

export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ repoId?: string }>;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/signin");
  }

  const { repoId } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
      <div className="container flex max-w-6xl flex-col items-center gap-12 px-4 py-16">
        <div className="flex flex-col items-center gap-4">
          <Link
            href="/"
            className="text-3xl font-bold hover:text-[hsl(280,100%,70%)]"
          >
            Checkpoint<span className="text-[hsl(280,100%,70%)]">VCS</span>
          </Link>
          <h1 className="text-2xl font-semibold">Labels</h1>
          <p className="text-center text-gray-300">
            View and manage changelist labels for this repository
          </p>
        </div>

        {repoId ? (
          <LabelsView repoId={repoId} />
        ) : (
          <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-gray-400">
            No repository selected. Please provide a <code>repoId</code> query
            parameter.
          </div>
        )}

        <div className="text-center">
          <Link
            href="/"
            className="text-sm text-gray-400 transition-colors hover:text-white"
          >
            ← Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}
