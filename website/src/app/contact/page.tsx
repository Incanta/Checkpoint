"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setErrorMessage("Please enter a valid email address.");
      setStatus("error");
      return;
    }

    setStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("https://api.incanta.games/contact/checkpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          message: message.replace(/\r/g, "").replace(/\n/g, "<br>"),
        }),
      });

      if (res.status === 429) {
        setErrorMessage(
          "You've already submitted this message recently. Please wait a moment before trying again."
        );
        setStatus("error");
        return;
      }

      if (res.ok) {
        setName("");
        setEmail("");
        setMessage("");
        setStatus("success");
        setTimeout(() => setStatus("idle"), 3000);
      } else {
        throw new Error("Request failed");
      }
    } catch {
      setErrorMessage(
        "Something went wrong. Please try again, or email us directly at support@checkpointvcs.com."
      );
      setStatus("error");
    }
  };

  return (
    <>
      <Navbar />
      <main className="flex-1 relative">
        {/* Background effects */}
        <div className="absolute inset-0 bg-grid" />
        <div className="absolute inset-0 bg-radial-primary" />

        <section className="relative z-10 min-h-screen flex items-center justify-center py-32 px-6 lg:px-8">
          <div className="w-full max-w-xl text-center">
            {/* Header */}
            <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
              Get in touch
            </p>
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
              Contact Us
            </h1>
            <p className="text-muted text-lg mb-10">
              Have a question or want to learn more? Send us a message or email
              us at{" "}
              <a
                href="mailto:support@checkpointvcs.com"
                className="text-primary-light hover:underline"
              >
                support@checkpointvcs.com
              </a>
              .
            </p>

            {/* Form */}
            <form
              onSubmit={handleSubmit}
              className="mx-auto flex flex-col gap-4 text-left"
            >
              <div>
                <label className="block text-sm font-medium text-muted mb-1.5">
                  Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-muted mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-muted mb-1.5">
                  Message
                </label>
                <textarea
                  rows={5}
                  required
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="w-full rounded-xl glass px-4 py-3 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all resize-y"
                />
              </div>

              <button
                type="submit"
                disabled={status === "submitting"}
                className="mt-2 rounded-full bg-primary px-8 py-3 text-sm font-semibold text-white transition-all hover:bg-primary-light hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {status === "submitting"
                  ? "Submitting..."
                  : status === "success"
                    ? "✓ Message Sent!"
                    : "Submit"}
              </button>

              {status === "error" && (
                <p className="text-sm text-red-400 text-center">
                  {errorMessage}
                </p>
              )}
            </form>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
