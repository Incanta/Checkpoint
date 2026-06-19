"use client";

import Image from "next/image";
import { COMING_SOON } from "@/config";
import Link from "next/link";
import { useState } from "react";

const navLinks = [
  { label: "Features", href: "#features" },
  // { label: "Docs", href: "/docs" },
  // { label: "Blog", href: "/blog" },
  { label: "Contact", href: "/contact" },
  {
    label: "GitHub",
    href: "https://github.com/Incanta/Checkpoint",
    external: true,
  },
];

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3 group">
            <Image
              src="/logo.svg"
              alt="Checkpoint VCS"
              width={36}
              height={36}
              className="rounded-full transition-transform group-hover:scale-105"
            />
            <span className="text-lg font-semibold tracking-tight">
              Checkpoint
            </span>
          </Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noopener noreferrer" : undefined}
                className="text-sm text-muted hover:text-foreground transition-colors"
              >
                {link.label}
                {link.external && (
                  <svg
                    className="inline-block ml-1 w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"
                    />
                  </svg>
                )}
              </a>
            ))}
            {COMING_SOON ? (
              <a
                href="#"
                className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition-all hover:bg-primary-light hover:shadow-lg hover:shadow-primary/25"
              >
                Get Started
              </a>
            ) : (
              <a
                href="https://app.checkpointvcs.com"
                className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition-all hover:bg-primary-light hover:shadow-lg hover:shadow-primary/25"
              >
                Get Started
              </a>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden p-2 text-muted hover:text-foreground"
            aria-label="Toggle menu"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              {mobileOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden glass-strong border-t border-border px-6 py-4 space-y-3">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
              className="block text-sm text-muted hover:text-foreground transition-colors"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </a>
          ))}
          {COMING_SOON ? (
            <a
              href="#"
              className="block w-full text-center rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition-all hover:bg-primary-light"
              onClick={() => setMobileOpen(false)}
            >
              Get Started
            </a>
          ) : (
            <a
              href="https://app.checkpointvcs.com"
              className="block w-full text-center rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition-all hover:bg-primary-light"
            >
              Get Started
            </a>
          )}
        </div>
      )}
    </nav>
  );
}
