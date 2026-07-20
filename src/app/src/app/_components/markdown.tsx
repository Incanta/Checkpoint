"use client";

import { useState, useEffect } from "react";
import type { Options as MdOptions } from "react-markdown";
import type RemarkGfm from "remark-gfm";
import {
  fillIssueUrl,
  tokenizeIssueRefs,
  type IssuesPlatformKind,
} from "~/lib/issue-refs";

export interface IssueLinkInfo {
  platform: IssuesPlatformKind;
  // External URL template containing "{id}", or null when links are internal
  urlTemplate: string | null;
  // App path of the repo, e.g. "/my-org/my-repo" (used for internal links)
  basePath: string;
}

export function issueRefUrl(
  info: IssueLinkInfo,
  refId: string,
): string | null {
  if (info.platform === "CHECKPOINT") {
    return `${info.basePath}/issues/${refId}`;
  }
  return info.urlTemplate ? fillIssueUrl(info.urlTemplate, refId) : null;
}

// Rewrites "#<id>" issue refs into markdown links before rendering. Known
// limitation: refs inside fenced code blocks are rewritten too.
function linkifyIssueRefs(content: string, info: IssueLinkInfo): string {
  return tokenizeIssueRefs(content, info.platform)
    .map((segment) => {
      if (segment.type === "ref" && segment.refId) {
        const url = issueRefUrl(info, segment.refId);
        if (url) {
          return `[${segment.text}](${url})`;
        }
      }
      return segment.text;
    })
    .join("");
}

// Shared lazy-loaded markdown renderer (react-markdown + GFM). Pass
// issueLink to hyperlink "#<id>" issue references.
export function MarkdownContent({
  content,
  issueLink,
  loadingFallback = "…",
}: {
  content: string;
  issueLink?: IssueLinkInfo;
  loadingFallback?: string;
}) {
  const [Md, setMd] = useState<React.ComponentType<MdOptions> | null>(null);
  const [remarkGfm, setRemarkGfm] = useState<typeof RemarkGfm | null>(null);

  useEffect(() => {
    void Promise.all([import("react-markdown"), import("remark-gfm")]).then(
      ([md, gfm]) => {
        setMd(() => md.default);
        setRemarkGfm(() => gfm.default);
      },
    );
  }, []);

  if (!Md)
    return (
      <span className="text-[var(--color-text-muted)]">{loadingFallback}</span>
    );

  const processed = issueLink
    ? linkifyIssueRefs(content, issueLink)
    : content;

  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <Md
        remarkPlugins={remarkGfm ? [remarkGfm] : []}
        components={{
          a: ({ href, children, ...props }) => {
            const external = /^https?:\/\//.test(href ?? "");
            return (
              <a
                href={href}
                {...props}
                {...(external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {processed}
      </Md>
    </div>
  );
}
