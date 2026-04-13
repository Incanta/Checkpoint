"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function DevBillingPage() {
  useDocumentTitle("Dev Billing Tools · Checkpoint VCS");

  const [selectedOrgId, setSelectedOrgId] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);

  // Date override fields
  const [trialEndsAt, setTrialEndsAt] = useState("");
  const [delinquentSince, setDelinquentSince] = useState("");
  const [suspendedAt, setSuspendedAt] = useState("");
  const [canceledAt, setCanceledAt] = useState("");
  const [overrideStatus, setOverrideStatus] = useState("");

  const appendLog = (msg: string) => {
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
  };

  const { data: orgs, refetch: refetchOrgs } =
    api.billingDev.listOrgs.useQuery();
  const { data: schedulerState, refetch: refetchScheduler } =
    api.billingDev.getSchedulerState.useQuery();
  const { data: invoices, refetch: refetchInvoices } =
    api.billingDev.listInvoices.useQuery(
      { orgId: selectedOrgId },
      { enabled: !!selectedOrgId },
    );

  const triggerMeterReport = api.billingDev.triggerMeterReport.useMutation({
    onSuccess: (data: { orgId?: string; storageBuckets?: number; reported?: number; total?: number }) => {
      if (data.orgId) {
        appendLog(`Meter report: org ${data.orgId}, ${data.storageBuckets ?? 0} storage buckets`);
      } else {
        appendLog(`Meter report: ${data.reported ?? 0}/${data.total ?? 0} orgs reported`);
      }
      void refetchOrgs();
    },
    onError: (err: { message: string }) => appendLog(`Error: ${err.message}`),
  });

  const triggerDaily = api.billingDev.triggerDailyChecks.useMutation({
    onSuccess: () => {
      appendLog("Daily checks completed");
      void refetchOrgs();
    },
    onError: (err) => appendLog(`Error: ${err.message}`),
  });

  const triggerTrialExpiry = api.billingDev.triggerTrialExpiry.useMutation({
    onSuccess: () => {
      appendLog("Trial expiry check completed");
      void refetchOrgs();
    },
    onError: (err) => appendLog(`Error: ${err.message}`),
  });

  const triggerDelinquency = api.billingDev.triggerDelinquencyCheck.useMutation(
    {
      onSuccess: () => {
        appendLog("Delinquency check completed");
        void refetchOrgs();
      },
      onError: (err) => appendLog(`Error: ${err.message}`),
    },
  );

  const resetScheduler = api.billingDev.resetSchedulerState.useMutation({
    onSuccess: () => {
      appendLog("Scheduler state reset");
      void refetchScheduler();
    },
    onError: (err) => appendLog(`Error: ${err.message}`),
  });

  const setOrgDates = api.billingDev.setOrgDates.useMutation({
    onSuccess: (org) => {
      appendLog(
        `Updated ${org.name}: status=${String(org.subscriptionStatus)}, trial=${formatDate(org.trialEndsAt)}`,
      );
      void refetchOrgs();
    },
    onError: (err) => appendLog(`Error: ${err.message}`),
  });

  const setInvoiceStatus = api.billingDev.setInvoiceStatus.useMutation({
    onSuccess: (inv) => {
      appendLog(
        `Invoice ${inv.id} → ${String(inv.status)} (${formatCents(inv.totalCents)})`,
      );
      void refetchInvoices();
      void refetchOrgs();
    },
    onError: (err) => appendLog(`Error: ${err.message}`),
  });

  const selectedOrg = orgs?.find((o) => o.id === selectedOrgId);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Billing Dev Tools"
        description="Manual triggers for testing time-dependent billing operations."
      />

      {/* Scheduler State */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Scheduler State
            </h3>
            <div className="mt-1 space-x-4 text-xs text-[var(--color-text-muted)]">
              <span>
                Last daily run:{" "}
                <strong>{schedulerState?.lastDailyRun ?? "never"}</strong>
              </span>
              <span>
                Running:{" "}
                <Badge
                  variant={schedulerState?.isRunning ? "success" : "default"}
                >
                  {schedulerState?.isRunning ? "yes" : "no"}
                </Badge>
              </span>
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => resetScheduler.mutate()}
            disabled={resetScheduler.isPending}
          >
            Reset State
          </Button>
        </div>
      </Card>

      {/* Org Selector */}
      <Card>
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
          Select Organization
        </h3>
        <select
          value={selectedOrgId}
          onChange={(e) => setSelectedOrgId(e.target.value)}
          className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
        >
          <option value="">— Select an org —</option>
          {orgs?.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name} ({String(org.subscriptionStatus ?? "none")} /{" "}
              {String(org.subscriptionTier ?? "none")})
            </option>
          ))}
        </select>

        {selectedOrg && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--color-text-muted)]">
            <div>Stripe Customer: {selectedOrg.stripeCustomerId ?? "—"}</div>
            <div>Subscription: {selectedOrg.stripeSubscriptionId ?? "—"}</div>
            <div>Trial Ends: {formatDate(selectedOrg.trialEndsAt)}</div>
            <div>
              Delinquent Since: {formatDate(selectedOrg.delinquentSince)}
            </div>
            <div>Suspended: {formatDate(selectedOrg.suspendedAt)}</div>
            <div>Canceled: {formatDate(selectedOrg.canceledAt)}</div>
            <div>Credits: {formatCents(selectedOrg.creditBalanceCents)}</div>
          </div>
        )}
      </Card>

      {/* Batch Triggers */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
          Trigger Operations
        </h3>
        <div className="space-y-3">
          {/* Meter reporting */}
          <div className="flex items-end gap-2">
            <Button
              onClick={() =>
                triggerMeterReport.mutate(
                  selectedOrgId ? { orgId: selectedOrgId } : undefined,
                )
              }
              disabled={triggerMeterReport.isPending}
            >
              {selectedOrgId
                ? "Report Meters for Selected Org"
                : "Report Meters for All Orgs"}
            </Button>
          </div>

          {/* Daily checks */}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => triggerDaily.mutate()}
              disabled={triggerDaily.isPending}
            >
              Run Daily Checks
            </Button>
            <Button
              variant="secondary"
              onClick={() => triggerTrialExpiry.mutate()}
              disabled={triggerTrialExpiry.isPending}
            >
              Check Trial Expiry
            </Button>
            <Button
              variant="secondary"
              onClick={() => triggerDelinquency.mutate()}
              disabled={triggerDelinquency.isPending}
            >
              Check Delinquency
            </Button>
          </div>
        </div>
      </Card>

      {/* Date Overrides */}
      {selectedOrgId && (
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
            Override Org Dates
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--color-text-muted)]">
                Trial Ends At
              </label>
              <input
                type="datetime-local"
                value={trialEndsAt}
                onChange={(e) => setTrialEndsAt(e.target.value)}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--color-text-muted)]">
                Delinquent Since
              </label>
              <input
                type="datetime-local"
                value={delinquentSince}
                onChange={(e) => setDelinquentSince(e.target.value)}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--color-text-muted)]">
                Suspended At
              </label>
              <input
                type="datetime-local"
                value={suspendedAt}
                onChange={(e) => setSuspendedAt(e.target.value)}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--color-text-muted)]">
                Canceled At
              </label>
              <input
                type="datetime-local"
                value={canceledAt}
                onChange={(e) => setCanceledAt(e.target.value)}
                className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="block text-xs text-[var(--color-text-muted)]">
              Subscription Status
            </label>
            <select
              value={overrideStatus}
              onChange={(e) => setOverrideStatus(e.target.value)}
              className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-sm text-[var(--color-text-primary)]"
            >
              <option value="">— No change —</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="TRIAL">TRIAL</option>
              <option value="PAST_DUE">PAST_DUE</option>
              <option value="SUSPENDED">SUSPENDED</option>
              <option value="CANCELED">CANCELED</option>
            </select>
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              onClick={() => {
                const input: Record<string, unknown> = {
                  orgId: selectedOrgId,
                };
                if (trialEndsAt)
                  input.trialEndsAt = new Date(trialEndsAt).toISOString();
                if (delinquentSince)
                  input.delinquentSince = new Date(
                    delinquentSince,
                  ).toISOString();
                if (suspendedAt)
                  input.suspendedAt = new Date(suspendedAt).toISOString();
                if (canceledAt)
                  input.canceledAt = new Date(canceledAt).toISOString();
                if (overrideStatus) input.subscriptionStatus = overrideStatus;

                setOrgDates.mutate(input as any);
              }}
              disabled={setOrgDates.isPending}
            >
              Apply Date Overrides
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // Set trial to expired (yesterday)
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                setOrgDates.mutate({
                  orgId: selectedOrgId,
                  trialEndsAt: yesterday.toISOString(),
                });
              }}
              disabled={setOrgDates.isPending}
            >
              Expire Trial Now
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // Set delinquent since 15 days ago (past suspend threshold)
                const past = new Date();
                past.setDate(past.getDate() - 15);
                setOrgDates.mutate({
                  orgId: selectedOrgId,
                  delinquentSince: past.toISOString(),
                  subscriptionStatus: "PAST_DUE",
                });
              }}
              disabled={setOrgDates.isPending}
            >
              Simulate 15-Day Delinquency
            </Button>
          </div>
        </Card>
      )}

      {/* Invoices */}
      {selectedOrgId && invoices && invoices.length > 0 && (
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">
            Invoices
          </h3>
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded border border-[var(--color-border-default)] px-3 py-2 text-sm"
              >
                <div className="text-[var(--color-text-primary)]">
                  {inv.year}-{String(inv.month).padStart(2, "0")} —{" "}
                  {formatCents(inv.totalCents)}
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                    ({inv.items.length} items)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      inv.status === "PAID"
                        ? "success"
                        : inv.status === "FAILED"
                          ? "danger"
                          : "default"
                    }
                  >
                    {String(inv.status)}
                  </Badge>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        setInvoiceStatus.mutate({
                          invoiceId: inv.id,
                          status: e.target.value as
                            | "DRAFT"
                            | "ISSUED"
                            | "PAID"
                            | "FAILED"
                            | "HELD",
                        });
                      }
                    }}
                    className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-1 py-0.5 text-xs text-[var(--color-text-primary)]"
                  >
                    <option value="">Set status...</option>
                    <option value="DRAFT">DRAFT</option>
                    <option value="ISSUED">ISSUED</option>
                    <option value="PAID">PAID</option>
                    <option value="FAILED">FAILED</option>
                    <option value="HELD">HELD</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Log */}
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Log
          </h3>
          <Button variant="secondary" onClick={() => setLog([])}>
            Clear
          </Button>
        </div>
        <div className="mt-2 max-h-48 overflow-y-auto rounded bg-[var(--color-bg-tertiary)] p-2 font-mono text-xs text-[var(--color-text-secondary)]">
          {log.length === 0 ? (
            <span className="text-[var(--color-text-muted)]">
              No operations yet.
            </span>
          ) : (
            log.map((entry, i) => <div key={i}>{entry}</div>)
          )}
        </div>
      </Card>
    </div>
  );
}
