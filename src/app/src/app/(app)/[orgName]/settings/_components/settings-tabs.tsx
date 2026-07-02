"use client";

import { api } from "~/trpc/react";
import { Tabs, Tab } from "~/app/_components/ui";

export function SettingsTabs({ orgName }: { orgName: string }) {
  const { data: checkoutSettings } = api.billing.getCheckoutSettings.useQuery();

  return (
    <Tabs className="mb-6">
      <Tab href={`/${orgName}/settings`} exact>
        General
      </Tab>
      <Tab href={`/${orgName}/settings/members`}>Members</Tab>
      {checkoutSettings?.enabled && (
        <Tab href={`/${orgName}/settings/billing`}>Billing</Tab>
      )}
    </Tabs>
  );
}
