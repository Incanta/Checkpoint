"use client";

import { useCallback } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import { tokenizeIssueRefs, type IssuesPlatformKind } from "~/lib/issue-refs";
import { issueRefUrl, type IssueLinkInfo } from "~/app/_components/markdown";

const LINK_CLASS = "text-[var(--color-info)] hover:underline";

// Resolves the repo's issues platform and returns helpers for hyperlinking
// "#<id>" issue references: `issueLink` for MarkdownContent, and `linkify`
// for plain-text surfaces like changelist messages.
export function useIssueLinker(orgName: string, repoName: string) {
  const basePath = `/${orgName}/${repoName}`;

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const platform: IssuesPlatformKind = repoData?.issuesPlatform ?? "DISABLED";
  const isExternal =
    platform === "JIRA" || platform === "CODECKS" || platform === "HACKNPLAN";

  const { data: linkInfo } = api.issueTracker.getLinkInfo.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id && isExternal, staleTime: 5 * 60 * 1000 },
  );

  const issueLink: IssueLinkInfo | undefined = repoData
    ? {
        platform,
        urlTemplate: isExternal ? (linkInfo?.issueUrlTemplate ?? null) : null,
        basePath,
      }
    : undefined;

  const urlTemplate = issueLink?.urlTemplate ?? null;

  const linkify = useCallback(
    (text: string): React.ReactNode => {
      if (!text || !issueLink || platform === "DISABLED") {
        return text;
      }

      const segments = tokenizeIssueRefs(text, platform);
      if (!segments.some((segment) => segment.type === "ref")) {
        return text;
      }

      return segments.map((segment, index) => {
        if (segment.type === "ref" && segment.refId) {
          const url = issueRefUrl(issueLink, segment.refId);
          if (url) {
            return platform === "CHECKPOINT" ? (
              <Link
                key={index}
                href={url}
                className={LINK_CLASS}
                onClick={(e) => e.stopPropagation()}
              >
                {segment.text}
              </Link>
            ) : (
              <a
                key={index}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
                onClick={(e) => e.stopPropagation()}
              >
                {segment.text}
              </a>
            );
          }
        }
        return segment.text;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [platform, urlTemplate, basePath, !!repoData],
  );

  return { platform, issueLink, linkify };
}
