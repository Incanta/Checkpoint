import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "~/server/auth";
import { LinkDeviceForm } from "./_components/link-device-form";
import { DevicesTable } from "./_components/devices-table";

export default async function DevicesPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/signin");
  }

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
          <h1 className="text-2xl font-semibold">Device Management</h1>
          <p className="text-center text-gray-300">
            Manage your linked devices and create new API tokens
          </p>
        </div>

        {/* Existing Devices Table */}
        <DevicesTable />

        {/* Link New Device Section */}
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <h2 className="mb-2 text-xl font-semibold text-white">
              Link New Device
            </h2>
            <p className="text-sm text-gray-400">
              Create an API token to link a new device to your account
            </p>
          </div>

          <LinkDeviceForm />

          <div className="mt-6 text-center">
            <Link
              href="/"
              className="text-sm text-gray-400 transition-colors hover:text-white"
            >
              ← Back to Home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
