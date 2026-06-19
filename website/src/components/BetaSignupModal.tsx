"use client";

import { useEffect, useState } from "react";
import { tiers } from "./Pricing";

const USER_COUNT_OPTIONS = [
  "1",
  "2-4",
  "5-14",
  "15-29",
  "30-49",
  "50-99",
  "100+",
];

const HOSTING_OPTIONS = [
  { value: "self-hosted", label: "Self-hosted" },
  { value: "cloud", label: "Cloud" },
];

const VCS_OPTIONS = [
  "Perforce",
  "Git",
  "Unity Version Control",
  "SVN",
  "No VCS Yet",
  "Other",
];

interface BetaSignupModalProps {
  open: boolean;
  onClose: () => void;
}

export default function BetaSignupModal({ open, onClose }: BetaSignupModalProps) {
  const tierOptions = tiers.filter((t) => t.enabled).map((t) => t.name);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [userCount, setUserCount] = useState("");
  const [hosting, setHosting] = useState(HOSTING_OPTIONS[0].value);
  const [tier, setTier] = useState("");
  const [currentVcs, setCurrentVcs] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  // Close on Escape and lock body scroll while open
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("https://api.incanta.games/beta/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email,
          company: company.trim(),
          userCount,
          hosting,
          tier,
          currentVcs,
        }),
      });

      if (res.ok) {
        setStatus("success");
      } else {
        throw new Error("Request failed");
      }
    } catch {
      setErrorMessage(
        "Something went wrong. Please try again, or contact us if the issue persists."
      );
      setStatus("error");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Join the beta"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="relative w-full max-w-md glass rounded-2xl p-8 shadow-2xl"
        style={{ background: "rgba(12, 12, 26, 0.96)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-muted hover:text-foreground transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {status === "success" ? (
          <div className="text-center py-6">
            <h2 className="text-2xl font-bold mb-3">You&apos;re on the list!</h2>
            <p className="text-muted text-sm mb-8">
              Thanks for your interest in the beta. We&apos;ll be in touch soon.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-primary px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-light hover:shadow-xl hover:shadow-primary/30"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-2">
              Beta access
            </p>
            <h2 className="text-2xl font-bold tracking-tight mb-2">Join the beta</h2>
            <p className="text-muted text-sm mb-6">
              Tell us a bit about your team and we&apos;ll reach out with access.
            </p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <input
                type="text"
                placeholder="Name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
              />
              <input
                type="email"
                placeholder="Email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
              />
              <input
                type="text"
                placeholder="Company name (optional)"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
              />
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted/70 font-medium mb-2">
                  Interested in
                </label>
                <div className="grid grid-cols-2 gap-2 glass rounded-xl p-1">
                  {HOSTING_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setHosting(option.value)}
                      className={`rounded-lg px-4 py-2 text-sm font-medium transition-all cursor-pointer ${
                        hosting === option.value
                          ? "bg-primary text-white shadow-lg shadow-primary/25"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="beta-tier"
                  className="block text-xs uppercase tracking-wider text-muted/70 font-medium mb-2"
                >
                  Tier of interest
                </label>
                <select
                  id="beta-tier"
                  required
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                  className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                >
                  <option value="" disabled className="bg-background text-foreground">
                    Select an option...
                  </option>
                  {tierOptions.map((option) => (
                    <option key={option} value={option} className="bg-background text-foreground">
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="beta-user-count"
                  className="block text-xs uppercase tracking-wider text-muted/70 font-medium mb-2"
                >
                  Number of users
                </label>
                <select
                  id="beta-user-count"
                  required
                  value={userCount}
                  onChange={(e) => setUserCount(e.target.value)}
                  className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                >
                  <option value="" disabled className="bg-background text-foreground">
                    Select an option...
                  </option>
                  {USER_COUNT_OPTIONS.map((option) => (
                    <option key={option} value={option} className="bg-background text-foreground">
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="beta-current-vcs"
                  className="block text-xs uppercase tracking-wider text-muted/70 font-medium mb-2"
                >
                  Current version control
                </label>
                <select
                  id="beta-current-vcs"
                  required
                  value={currentVcs}
                  onChange={(e) => setCurrentVcs(e.target.value)}
                  className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                >
                  <option value="" disabled className="bg-background text-foreground">
                    Select an option...
                  </option>
                  {VCS_OPTIONS.map((option) => (
                    <option key={option} value={option} className="bg-background text-foreground">
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={status === "submitting"}
                className="mt-2 rounded-full bg-primary px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-light hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {status === "submitting" ? "Submitting..." : "Join Beta"}
              </button>

              {status === "error" && (
                <p className="text-sm text-red-400">{errorMessage}</p>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
}
