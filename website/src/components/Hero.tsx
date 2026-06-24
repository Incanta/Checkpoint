import Image from "next/image";
import Link from "next/link";

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-grid" />
      <div className="absolute inset-0 bg-radial-primary" />

      {/* Floating orbs */}
      <div className="absolute top-1/4 left-1/6 w-72 h-72 bg-primary/10 rounded-full blur-3xl animate-pulse-glow" />
      <div className="absolute bottom-1/4 right-1/6 w-96 h-96 bg-accent/5 rounded-full blur-3xl animate-pulse-glow [animation-delay:1.5s]" />

      <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8 text-center pt-24 pb-16">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="relative animate-float">
            <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl scale-150" />
            <Image
              src="/logo.svg"
              alt="Checkpoint VCS logo"
              width={120}
              height={120}
              className="relative rounded-full glow-primary-strong"
              priority
            />
          </div>
        </div>

        {/* Badge */}
        <div className="flex justify-center mb-8">
          <a
            href="https://github.com/Incanta/Checkpoint"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 glass rounded-full px-4 py-1.5 text-xs font-medium text-muted hover:text-foreground transition-colors"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
            Open Source on GitHub
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </a>
        </div>

        {/* Headline */}
        <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1] mb-6">
          <span className="block">Version control for</span>
          <span className="block bg-gradient-to-r from-primary via-accent to-primary-light bg-clip-text text-transparent">
            creative workflows
          </span>
        </h1>

        {/* Speed callout */}
        <div className="flex justify-center mb-6">
          <a
            href="#performance"
            className="inline-flex items-center gap-3 glass-primary rounded-full px-6 py-2.5 transition-all hover:scale-[1.03] hover:shadow-lg hover:shadow-primary/20"
          >
            <span className="text-sm sm:text-base font-medium text-foreground">
              up to
            </span>
            <span className="text-2xl sm:text-3xl font-extrabold bg-gradient-to-r from-primary-light to-accent bg-clip-text text-transparent">
              73%
            </span>
            <span className="text-sm sm:text-base font-medium text-foreground">
              faster than Perforce
            </span>
            <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </a>
        </div>

        {/* Subtitle */}
        <p className="mx-auto max-w-2xl text-lg sm:text-xl text-muted leading-relaxed mb-10">
          Checkpoint is a modern VCS built for media-heavy projects: games,
          film, product design, architecture, and more. Fast checkouts, file
          locking, and massive file support, out of the box.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/download"
            className="group relative rounded-full bg-primary px-8 py-3.5 text-base font-semibold text-white transition-all hover:bg-primary-light hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02]"
          >
            <span className="relative z-10">Download</span>
          </Link>
          <a
            href="/docs/quickstart"
            className="group flex items-center gap-2 rounded-full glass px-8 py-3.5 text-base font-semibold text-foreground transition-all hover:bg-surface-hover hover:scale-[1.02]"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 12V7a2 2 0 012-2h10a2 2 0 012 2v5M5 12h14a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3a2 2 0 012-2zM8 16h.01M12 16h.01"
              />
            </svg>
            Host a Server
          </a>
        </div>

        {/* Supported workflows */}
        <div className="mt-20 flex flex-wrap items-center justify-center gap-x-8 gap-y-4 text-sm text-muted">
          <span className="text-xs uppercase tracking-wider font-medium text-muted/60">
            Built for
          </span>
          {[
            "Game Dev",
            "Film & VFX",
            "Product Design",
            "Architecture",
            "CAD & Engineering",
          ].map((label) => (
            <span
              key={label}
              className="glass rounded-full px-4 py-1.5 text-xs font-medium"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
