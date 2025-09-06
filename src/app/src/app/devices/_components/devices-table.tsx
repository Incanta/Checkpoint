"use client";

import { useState } from "react";
import { api } from "~/trpc/react";

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
      void refetch(); // Refresh the devices list
    },
    onError: (error) => {
      setError(error.message);
    },
  });

  const handleRevokeDevice = async (deviceId: string, deviceName: string) => {
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
      <div className="w-full max-w-4xl">
        <div className="rounded-lg border border-white/10 bg-white/5 p-6">
          <div className="animate-pulse text-gray-400">Loading devices...</div>
        </div>
      </div>
    );
  }

  const devices = devicesData?.activeDevices ?? [];

  return (
    <div className="w-full max-w-4xl">
      <div className="overflow-hidden rounded-lg border border-white/10 bg-white/5">
        <div className="border-b border-white/10 px-6 py-4">
          <h2 className="text-xl font-semibold text-white">Active Devices</h2>
          <p className="mt-1 text-sm text-gray-400">
            Manage devices that have access to your Checkpoint account
          </p>
        </div>

        {error && (
          <div className="mx-6 mt-4 rounded-md border border-red-500/50 bg-red-500/20 p-3 text-red-200">
            {error}
          </div>
        )}

        {devices.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-400">
            No active devices found. Link a device to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead className="bg-white/5">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase">
                    Device Name
                  </th>
                  <th className="hidden px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase sm:table-cell">
                    Created
                  </th>
                  <th className="hidden px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-300 uppercase md:table-cell">
                    Expires
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium tracking-wider text-gray-300 uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {devices.map((device) => (
                  <tr
                    key={device.id}
                    className="transition-colors hover:bg-white/5"
                  >
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-white">
                        {device.name}
                      </div>
                      <div className="text-xs text-gray-400 sm:hidden">
                        Created: {formatDate(device.createdAt)}
                      </div>
                      <div className="text-xs text-gray-400 md:hidden">
                        Expires: {formatExpiration(device.expiresAt)}
                      </div>
                    </td>
                    <td className="hidden px-6 py-4 whitespace-nowrap sm:table-cell">
                      <div className="text-sm text-gray-300">
                        {formatDate(device.createdAt)}
                      </div>
                    </td>
                    <td className="hidden px-6 py-4 whitespace-nowrap md:table-cell">
                      <div className="text-sm text-gray-300">
                        {formatExpiration(device.expiresAt)}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right whitespace-nowrap">
                      <button
                        onClick={() =>
                          handleRevokeDevice(device.id, device.name)
                        }
                        disabled={revokeDevice.isPending}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-red-500/20 text-red-400 transition-colors hover:bg-red-500/30 hover:text-red-300 focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-[#15162c] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        title={`Revoke access for ${device.name}`}
                      >
                        {revokeDevice.isPending ? (
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-400 border-t-transparent" />
                        ) : (
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
