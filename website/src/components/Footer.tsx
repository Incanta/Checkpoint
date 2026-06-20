import Image from "next/image";

export default function Footer() {
  return (
    <footer className="relative border-t border-border">
      <div className="mx-auto max-w-7xl px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Logo & company */}
          <div className="flex items-center gap-3">
            <Image
              src="/logo.svg"
              alt="Checkpoint VCS"
              width={28}
              height={28}
              className="rounded-full"
            />
            <span className="text-sm text-muted">
              Built by{" "}
              <a
                href="https://incanta.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground hover:text-primary transition-colors"
              >
                Incanta
              </a>
            </span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6 text-sm text-muted">
            <a
              href="https://github.com/Incanta/Checkpoint"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              GitHub
            </a>
            <a
              href="/contact"
              className="hover:text-foreground transition-colors"
            >
              Contact
            </a>
            {/* <a
              href="https://app.checkpointvcs.com"
              className="hover:text-foreground transition-colors"
            >
              App
            </a> */}
          </div>

          {/* Copyright */}
          <p className="text-xs text-muted/60">
            &copy; {new Date().getFullYear()} Incanta. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
