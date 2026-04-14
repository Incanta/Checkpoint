"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react";
import { Button, Card, PageHeader, Badge } from "~/app/_components/ui";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

type Step = "name" | "trial";

const TIER_FEATURES: Record<string, string[]> = {
  BASIC: ["Checkouts & locking", "Branching", "All clients"],
  PRO: ["Pull requests & reviews", "Shelves", "Horde integration", "Artifacts"],
  STUDIO: ["Data replicas", "Enterprise SAML"],
};

const TIER_PRICING: Record<string, { write: number; read: number | string }> = {
  BASIC: { write: 3, read: "1.50" },
  PRO: { write: 6, read: 3 },
  STUDIO: { write: 14, read: 7 },
};

export default function NewOrgPage() {
  useDocumentTitle("New Organization · Checkpoint VCS");
  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>("name");
  const [tier, setTier] = useState<"BASIC" | "PRO" | "STUDIO">("BASIC");
  const [useTrial, setUseTrial] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const router = useRouter();
  const utils = api.useUtils();

  const { data: checkoutSettings } = api.billing.getCheckoutSettings.useQuery();
  const { data: trialStatus } = api.billing.getTrialStatus.useQuery();
  const billingEnabled = checkoutSettings?.enabled ?? false;
  const canUseTrial = !trialStatus?.trialUsed;

  const createCheckout = api.billing.createCheckoutSession.useMutation({
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        setRedirecting(true);
        window.location.href = data.checkoutUrl;
      }
    },
  });

  const createOrg = api.org.createOrg.useMutation({
    onSuccess: (org) => {
      void utils.org.myOrgs.invalidate();
      router.push(`/${org.name}`);
    },
  });

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (billingEnabled && canUseTrial) {
      setStep("trial");
    } else if (billingEnabled) {
      // No trial available, go straight to checkout
      createCheckout.mutate({
        orgName: name.trim(),
        tier,
        useTrial: false,
        successUrl: `${window.location.origin}/${name.trim()}?checkout=success`,
        cancelUrl: `${window.location.origin}/new/org?checkout=canceled`,
      });
    } else {
      createOrg.mutate({ name: name.trim() });
    }
  };

  const handleCreate = () => {
    createCheckout.mutate({
      orgName: name.trim(),
      tier,
      useTrial,
      successUrl: `${window.location.origin}/${name.trim()}?checkout=success`,
      cancelUrl: `${window.location.origin}/new/org?checkout=canceled`,
    });
  };

  const isPending =
    createOrg.isPending || createCheckout.isPending || redirecting;
  const error = createOrg.error ?? createCheckout.error;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Create a new organization"
        description="Organizations help you group repositories and manage team access."
      />

      {/* Step indicators for billing flow */}
      {billingEnabled && canUseTrial && (
        <div className="mb-4 flex items-center gap-2">
          {(["name", "trial"] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && (
                <div className="h-px w-6 bg-[var(--color-border-default)]" />
              )}
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                  step === s
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
                }`}
              >
                {i + 1}
              </div>
              <span
                className={`text-xs ${
                  step === s
                    ? "text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-muted)]"
                }`}
              >
                {s === "name" ? "Name & Plan" : "Trial"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Step 1: Name & Plan */}
      {step === "name" && (
        <Card>
          <form onSubmit={handleNameSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="org-name"
                className="mb-1 block text-sm font-medium text-[var(--color-text-primary)]"
              >
                Organization name
              </label>
              <input
                id="org-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-org"
                autoFocus
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </div>

            {billingEnabled && (
              <div>
                <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
                  Plan
                </label>
                <div className="grid grid-cols-3 items-start gap-3">
                  {(["BASIC", "PRO", "STUDIO"] as const).map((t) => {
                    const pricing = TIER_PRICING[t]!;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTier(t)}
                        className={`rounded-md border p-4 text-left text-sm transition-colors ${
                          tier === t
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                            : "border-[var(--color-border-default)] hover:border-[var(--color-accent)]/50"
                        }`}
                      >
                        <Badge
                          variant={
                            t === "STUDIO"
                              ? "accent"
                              : t === "PRO"
                                ? "info"
                                : "default"
                          }
                        >
                          {t}
                        </Badge>

                        <div className="mt-3 space-y-0.5">
                          <p className="text-lg font-bold text-[var(--color-text-primary)]">
                            ${pricing.write}
                            <span className="text-xs font-normal text-[var(--color-text-muted)]">
                              /write user/mo
                            </span>
                          </p>
                          <p className="text-xs text-[var(--color-text-muted)]">
                            ${pricing.read}/read user/mo
                          </p>
                        </div>

                        <ul className="mt-3 space-y-0.5 text-xs text-[var(--color-text-secondary)]">
                          {(TIER_FEATURES[t] ?? []).map((f) => (
                            <li key={f}>• {f}</li>
                          ))}
                          {t !== "BASIC" && (
                            <li className="text-[var(--color-text-muted)]">
                              + all {t === "STUDIO" ? "Pro" : "Basic"} features
                            </li>
                          )}
                        </ul>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {error && (
              <p className="text-sm text-[var(--color-danger)]">
                {error.message}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                type="button"
                onClick={() => router.back()}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || isPending}>
                {isPending
                  ? "Setting up..."
                  : billingEnabled && canUseTrial
                    ? "Next: Trial"
                    : billingEnabled
                      ? "Continue to Payment"
                      : "Create organization"}
              </Button>
            </div>

            {billingEnabled && (
              <p className="text-xs text-[var(--color-text-muted)]">
                You&apos;ll be redirected to Stripe to enter your payment
                details.
              </p>
            )}
          </form>
        </Card>
      )}

      {/* Step 2: Trial */}
      {step === "trial" && (
        <Card>
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Free Trial
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Start with a 1-month free trial of the Basic plan. No charges
              during the trial period. Your subscription will automatically
              begin after the trial ends unless you cancel.
            </p>

            <div className="space-y-2">
              <label className="flex items-center gap-3 rounded-md border border-[var(--color-border-default)] p-3 transition-colors hover:border-[var(--color-accent)]/50">
                <input
                  type="radio"
                  name="trial"
                  checked={useTrial}
                  onChange={() => setUseTrial(true)}
                  className="accent-[var(--color-accent)]"
                />
                <div>
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">
                    Start free trial (excluding storage over 25GB)
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    30 days free, cancel anytime
                  </div>
                </div>
              </label>

              <label className="flex items-center gap-3 rounded-md border border-[var(--color-border-default)] p-3 transition-colors hover:border-[var(--color-accent)]/50">
                <input
                  type="radio"
                  name="trial"
                  checked={!useTrial}
                  onChange={() => setUseTrial(false)}
                  className="accent-[var(--color-accent)]"
                />
                <div>
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">
                    Start subscription immediately
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Billed monthly based on usage
                  </div>
                </div>
              </label>
            </div>

            {error && (
              <p className="text-sm text-[var(--color-danger)]">
                {error.message}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setStep("name")}>
                Back
              </Button>
              <Button onClick={handleCreate} disabled={isPending}>
                {isPending ? "Setting up..." : "Continue to Payment"}
              </Button>
            </div>

            <p className="text-xs text-[var(--color-text-muted)]">
              You&apos;ll be redirected to Stripe to enter your payment details.
            </p>
          </div>
        </Card>
      )}

      {/* Redirecting state */}
      {redirecting && (
        <Card>
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-[var(--color-text-muted)]">
              Redirecting to Stripe Checkout...
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
