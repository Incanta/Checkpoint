"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";

export function LinkDeviceForm() {
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
      // Reset form
      setFormData({
        name: "",
        deviceCode: "",
        expiration: "none",
      });
      // Invalidate and refetch the devices list
      void utils.apiToken.getActiveDevices.invalidate();
    },
    onError: (error) => {
      setError(error.message);
      setIsLoading(false);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    // Validate form
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

    // Calculate expiration date
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

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="name" className="mb-2 block text-sm font-medium">
          Token Name
        </label>
        <input
          type="text"
          id="name"
          name="name"
          value={formData.name}
          onChange={handleInputChange}
          placeholder="e.g., My Desktop, Work Laptop"
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-gray-400 focus:border-transparent focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:outline-none"
          disabled={isLoading}
        />
      </div>

      <div>
        <label htmlFor="deviceCode" className="mb-2 block text-sm font-medium">
          Device Code
        </label>
        <input
          type="text"
          id="deviceCode"
          name="deviceCode"
          value={formData.deviceCode}
          onChange={handleInputChange}
          placeholder="Enter the code from your device"
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-gray-400 focus:border-transparent focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:outline-none"
          disabled={isLoading}
        />
      </div>

      <div>
        <label htmlFor="expiration" className="mb-2 block text-sm font-medium">
          Token Expiration
        </label>
        <select
          id="expiration"
          name="expiration"
          value={formData.expiration}
          onChange={handleInputChange}
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white focus:border-transparent focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:outline-none"
          disabled={isLoading}
        >
          <option value="none">No expiration</option>
          <option value="1week">1 week</option>
          <option value="1month">1 month</option>
          <option value="1year">1 year</option>
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/50 bg-red-500/20 p-3 text-red-200">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-md border border-green-500/50 bg-green-500/20 p-3 text-green-200">
          API token created successfully! Your device should now be linked.
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="w-full rounded-md bg-[hsl(280,100%,70%)] px-4 py-2 font-semibold text-white transition-colors hover:bg-[hsl(280,100%,60%)] focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:ring-offset-2 focus:ring-offset-[#15162c] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? "Creating Token..." : "Link Device"}
      </button>
    </form>
  );
}
