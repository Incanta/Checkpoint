"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "~/app/_components/ui";

export function DevicesTable() {
  const [error, setError] = useState<string | null>(null);

  const {
    data: devicesData,
    isLoading,
    refetch,
  } = api.apiToken.getActiveDevices.useQuery();

  const revokeDevice = api.apiToken.revokeDevice.useMutation({
    onSuccess: () => {
      setError(null);
      void refetch();
    },
    onError: (error) => {
      setError(error.message);
    },
  });

  const handleRevokeDevice = (deviceId: string, deviceName: string) => {
    if (
      confirm(
        `Are you sure you want to revoke access for "${deviceName}"? This action cannot be undone.`,
      )
    ) {
      revokeDevice.mutate({ deviceId });
    }
  };

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(date));
  };

  const formatExpiration = (expiresAt: Date | null) => {
    if (!expiresAt) {
      return "Never";
    }

    const now = new Date();
    const expiration = new Date(expiresAt);

    if (expiration <= now) {
      return "Expired";
    }

    return formatDate(expiration);
  };

  if (isLoading) {
    return (
      <div className="animate-pulse text-sm text-[var(--color-text-muted)]">
        Loading devices...
      </div>
    );
  }

  const devices = devicesData?.activeDevices ?? [];

  if (devices.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        No active devices found. Link a device below to get started.
      </p>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border-default)]">
              <th className="pb-2 text-left text-xs font-medium uppercase text-[var(--color-text-muted)]">
                Device Name
              </th>
              <th className="hidden pb-2 text-left text-xs font-medium uppercase text-[var(--color-text-muted)] sm:table-cell">
                Created
              </th>
              <th className="hidden pb-2 text-left text-xs font-medium uppercase text-[var(--color-text-muted)] md:table-cell">
                Expires
              </th>
              <th className="pb-2 text-right text-xs font-medium uppercase text-[var(--color-text-muted)]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-default)]">
            {devices.map((device) => (
              <tr key={device.id}>
                <td className="py-3">
                  <div className="font-medium text-[var(--color-text-primary)]">
                    {device.name}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] sm:hidden">
                    Created: {formatDate(device.createdAt)}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] md:hidden">
                    Expires: {formatExpiration(device.expiresAt)}
                  </div>
                </td>
                <td className="hidden py-3 text-[var(--color-text-secondary)] sm:table-cell">
                  {formatDate(device.createdAt)}
                </td>
                <td className="hidden py-3 text-[var(--color-text-secondary)] md:table-cell">
                  {formatExpiration(device.expiresAt)}
                </td>
                <td className="py-3 text-right">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      handleRevokeDevice(device.id, device.name)
                    }
                    disabled={revokeDevice.isPending}
                  >
                    {revokeDevice.isPending ? "Revoking..." : "Revoke"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
