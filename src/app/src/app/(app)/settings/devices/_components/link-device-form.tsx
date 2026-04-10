"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { Button } from "~/app/_components/ui";

export function LinkDeviceForm() {
  return (
    <Suspense>
      <LinkDeviceFormContent />
    </Suspense>
  );
}

function LinkDeviceFormContent() {
  const [formData, setFormData] = useState({
    name: "",
    deviceCode: "",
    expiration: "none",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = searchParams.get("code");
    if (code) {
      setFormData((prev) => ({
        ...prev,
        deviceCode: code,
      }));
    }
  }, [searchParams]);

  const utils = api.useUtils();

  const createApiToken = api.apiToken.createApiToken.useMutation({
    onSuccess: () => {
      setSuccess(true);
      setError(null);
      setIsLoading(false);
      setFormData({
        name: "",
        deviceCode: "",
        expiration: "none",
      });
      void utils.apiToken.getActiveDevices.invalidate();
    },
    onError: (error) => {
      setError(error.message);
      setIsLoading(false);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    if (!formData.name.trim()) {
      setError("Name is required");
      setIsLoading(false);
      return;
    }

    if (!formData.deviceCode.trim()) {
      setError("Device code is required");
      setIsLoading(false);
      return;
    }

    let expiresAt: Date | null = null;
    const now = new Date();

    switch (formData.expiration) {
      case "1week":
        expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      case "1month":
        expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        break;
      case "1year":
        expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
        break;
      case "none":
      default:
        expiresAt = null;
        break;
    }

    createApiToken.mutate({
      name: formData.name.trim(),
      deviceCode: formData.deviceCode.trim(),
      expiresAt,
    });
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const inputClass =
    "w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="name"
          className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
        >
          Token Name
        </label>
        <input
          type="text"
          id="name"
          name="name"
          value={formData.name}
          onChange={handleInputChange}
          placeholder="e.g., My Desktop, Work Laptop"
          className={inputClass}
          disabled={isLoading}
        />
      </div>

      <div>
        <label
          htmlFor="deviceCode"
          className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
        >
          Device Code
        </label>
        <input
          type="text"
          id="deviceCode"
          name="deviceCode"
          value={formData.deviceCode}
          onChange={handleInputChange}
          placeholder="Enter the code from your device"
          className={inputClass}
          disabled={isLoading}
        />
      </div>

      <div>
        <label
          htmlFor="expiration"
          className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
        >
          Token Expiration
        </label>
        <select
          id="expiration"
          name="expiration"
          value={formData.expiration}
          onChange={handleInputChange}
          className={inputClass}
          disabled={isLoading}
        >
          <option value="none">No expiration</option>
          <option value="1week">1 week</option>
          <option value="1month">1 month</option>
          <option value="1year">1 year</option>
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 p-3 text-sm text-[var(--color-success)]">
          API token created successfully! Your device should now be linked.
        </div>
      )}

      <Button type="submit" disabled={isLoading} className="w-full">
        {isLoading ? "Creating Token..." : "Link Device"}
      </Button>
    </form>
  );
}
