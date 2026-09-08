"use client";

import { Tabs, Tab } from "~/app/_components/ui";
import { api } from "~/trpc/react";

/**
 * Admin section tabs.
 *
 * The admin section itself is open to any checkpoint admin, but Metrics and
 * Billing are backed by licenseManagerAdminProcedure and only exist on the
 * license manager instance, so they are hidden elsewhere.
 */
export function AdminTabs() {
  const { data: user } = api.user.me.useQuery();
  const licenseManager = !!user?.isLicenseManager;

  return (
    <Tabs className="mb-6">
      <Tab href="/admin" exact>
        Dashboard
      </Tab>
      {licenseManager && <Tab href="/admin/metrics">Metrics</Tab>}
      {licenseManager && <Tab href="/admin/billing">Billing</Tab>}
      <Tab href="/admin/updates">Updates</Tab>
    </Tabs>
  );
}
