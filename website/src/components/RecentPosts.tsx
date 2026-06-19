"use client";

import blogArchive from "@/blog-archive.json";

interface BlogPost {
  id: string;
  metadata: {
    permalink: string;
    title: string;
    description: string;
    date: string;
    unlisted: boolean;
    authors: { name: string }[];
  };
}

export default function RecentPosts() {
  const posts = (blogArchive as { blogPosts: BlogPost[] }).blogPosts
    .filter((p) => !p.metadata.unlisted)
    .slice(0, 3);

  if (posts.length === 0) return null;

  return (
    <section className="relative py-32 overflow-hidden">
      {/* Divider glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto max-w-5xl px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-12">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary mb-3">
            Blog
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Recent Posts
          </h2>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {posts.map((post) => {
            const blogDate = new Date(post.metadata.date.split("T")[0]);
            const dateTokens = blogDate.toDateString().split(" ");
            const dateString = `${dateTokens[1]} ${dateTokens[2]}, ${dateTokens[3]}`;

            return (
              <a
                key={post.id}
                href={post.metadata.permalink}
                className="group glass rounded-2xl p-6 flex flex-col justify-between gap-4 transition-all hover:bg-surface-hover hover:scale-[1.02]"
              >
                <div>
                  <h3 className="text-base font-semibold leading-snug line-clamp-2 group-hover:text-primary-light transition-colors">
                    {post.metadata.title}
                  </h3>
                  <p className="mt-2 text-sm text-muted line-clamp-3">
                    {post.metadata.description}
                  </p>
                </div>
                <span className="text-xs text-muted/60">{dateString}</span>
              </a>
            );
          })}
        </div>

        {/* View all link */}
        <div className="text-center mt-10">
          <a
            href="/blog"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary-light hover:underline"
          >
            View all posts
            <svg
              className="w-4 h-4"
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
      </div>
    </section>
  );
}
