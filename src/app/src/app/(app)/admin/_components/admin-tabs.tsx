"use client";

import { Tabs, Tab } from "~/app/_components/ui";

export function AdminTabs() {
  return (
    <Tabs className="mb-6">
      <Tab href="/admin" exact>
        Dashboard
      </Tab>
      <Tab href="/admin/metrics">Metrics</Tab>
      <Tab href="/admin/billing">Billing</Tab>
    </Tabs>
  );
}
