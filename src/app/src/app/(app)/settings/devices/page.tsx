import { DevicesTable } from "./_components/devices-table";
import { LinkDeviceForm } from "./_components/link-device-form";
import { PageHeader } from "~/app/_components/ui/page-header";
import { Card } from "~/app/_components/ui/card";
import { type Metadata } from "next";

export const metadata: Metadata = { title: "Devices · Checkpoint VCS" };

export default function DevicesPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Devices & Tokens"
        description="Manage your API tokens and connected devices."
      />

      <div className="space-y-6">
        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
            Active Devices
          </h2>
          <DevicesTable />
        </Card>

        <Card>
          <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
            Link a Device
          </h2>
          <LinkDeviceForm />
        </Card>
      </div>
    </div>
  );
}
