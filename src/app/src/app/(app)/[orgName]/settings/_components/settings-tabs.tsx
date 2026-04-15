"use client";

import { api } from "~/trpc/react";
import { Tabs, Tab } from "~/app/_components/ui";

export function SettingsTabs({ orgName }: { orgName: string }) {
  const { data: checkoutSettings } = api.billing.getCheckoutSettings.useQuery();
  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });

  return (
    <Tabs className="mb-6">
      <Tab href={`/${orgName}/settings`} exact>
        General
      </Tab>
      <Tab href={`/${orgName}/settings/members`}>Members</Tab>
      {checkoutSettings?.enabled && (
        <Tab href={`/${orgName}/settings/billing`}>Billing</Tab>
      )}
      {org?.selfHosted && (
        <Tab href={`/${orgName}/settings/license`}>License</Tab>
      )}
    </Tabs>
  );
}
