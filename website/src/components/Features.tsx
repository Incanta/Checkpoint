function Icon({ d }: { d: string }) {
  return (
    <svg
      className="w-6 h-6"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const features = [
  {
    title: "Checkouts & Locking",
    description:
      "Check out a file to claim it, so nobody else edits the same mesh or texture. Binary files get exclusive locks; text files auto-merge. No merge headaches on art files.",
    icon: (
      <Icon d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    ),
  },
  {
    title: "Massive File Support",
    description:
      "Designed from the ground up for large binary files. Content is chunked, deduplicated, and compressed, with no file size limits. Textures, meshes, video, and CAD files just work.",
    icon: (
      <Icon d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
    ),
  },
  {
    title: "Pending Changelists",
    description:
      "Stage work into separate pending changelists and submit each on its own, Perforce-style. Revert files you never changed in one click.",
    icon: (
      <Icon d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
    ),
  },
  {
    title: "Branches & Merge Requests",
    description:
      "Branch-based workflows with merge requests, changelist reviews, labels, and built-in issues. Text files merge three ways; a merge that would lose a change is refused.",
    icon: (
      <Icon d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    ),
  },
  {
    title: "Team Sync",
    description:
      "Sync to any changelist, grab precompiled binaries instead of building, run local build steps, and see CI status on every change. UnrealGameSync-style, for any engine.",
    icon: (
      <Icon d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    ),
  },
  {
    title: "Every Client You Need",
    description:
      "Desktop app, CLI, web UI, VS Code extension, Unreal Engine plugin, and an Unreal Horde integration for CI. Artists and programmers both get first-class tools.",
    icon: (
      <Icon d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
    ),
  },
  {
    title: "Self-Hosted, Your Storage",
    description:
      "Run the server with Docker Compose and keep files on its own disk, any S3-compatible store, or Cloudflare R2. Install updates and roll back from the admin panel.",
    icon: (
      <Icon d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
    ),
  },
  {
    title: "Secure Sign-In",
    description:
      "Invite-only membership, authenticator apps, passkeys, and org-wide MFA requirements. Sign in through Okta, Microsoft Entra ID, Google Workspace, or any OpenID Connect provider.",
    icon: (
      <Icon d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    ),
  },
  {
    title: "Open Source",
    description:
      "Dual-licensed under AGPLv3 or the Elastic License 2.0, your choice. Self-hosting is free and fully featured, with no license key.",
    icon: (
      <Icon d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
    ),
  },
];

export default function Features() {
  return (
    <section id="features" className="relative py-32 overflow-hidden">
      {/* Divider glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Section header */}
        <div className="text-center mb-16">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
            Features
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Everything your creative team needs
          </h2>
          <p className="mx-auto max-w-2xl text-muted text-lg">
            Purpose-built for media workflows where files are large, binary, and
            need to be managed with care.
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group glass rounded-2xl p-8 transition-all duration-300 hover:bg-surface-hover hover:border-border-light hover:scale-[1.02]"
            >
              <div className="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary group-hover:bg-primary/20 transition-colors">
                {feature.icon}
              </div>
              <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
              <p className="text-sm text-muted leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
