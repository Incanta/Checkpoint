"use client";

import { useState } from "react";

export default function Newsletter() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const nameTokens = name.trim().replace(/ {2,}/g, " ").split(" ");
    let lastName = "";
    if (nameTokens.length > 1) {
      lastName = nameTokens.pop()!;
    }
    const firstName = nameTokens.join(" ");

    setStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("https://api.incanta.games/subscribe/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
          email,
        }),
      });

      if (res.ok) {
        setName("");
        setEmail("");
        setStatus("success");
        setTimeout(() => setStatus("idle"), 3000);
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
    <section className="relative py-32 overflow-hidden">
      {/* Divider glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto max-w-2xl px-6 lg:px-8 text-center">
        {/* Header */}
        <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
          Stay in the loop
        </p>
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
          Sign up for our newsletter
        </h2>
        <p className="text-muted text-lg mb-10">
          Get the latest development updates and release announcements.
        </p>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="mx-auto max-w-md flex flex-col gap-4"
        >
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
          <button
            type="submit"
            disabled={status === "submitting"}
            className="rounded-full bg-primary px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-light hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {status === "submitting"
              ? "Submitting..."
              : status === "success"
                ? "✓ Subscribed!"
                : "Sign Up"}
          </button>

          {status === "error" && (
            <p className="text-sm text-red-400">{errorMessage}</p>
          )}
        </form>
      </div>
    </section>
  );
}
