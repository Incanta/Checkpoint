"use client";

import { useParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { api } from "~/trpc/react";
import { Card, EmptyState } from "~/app/_components/ui";
import { codeToHtml } from "shiki/bundle/full";
import { useDocumentTitle } from "~/app/_hooks/useDocumentTitle";

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    mdx: "mdx",
    css: "css",
    scss: "scss",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    graphql: "graphql",
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    lua: "lua",
    swift: "swift",
    r: "r",
    dart: "dart",
    vue: "vue",
    svelte: "svelte",
    prisma: "prisma",
    ini: "ini",
    env: "dotenv",
    txt: "text",
    log: "text",
    csv: "csv",
    uplugin: "jsonc",
    uproject: "jsonc",
  };
  return map[ext] ?? "text";
}

/**
 * Post-processes shiki HTML to wrap ONLY leading and trailing space/tab
 * characters in styled spans. Mid-line whitespace is left untouched.
 * Walks character-by-character, skipping content inside HTML tags.
 */
function applyWhitespaceMarkers(html: string): string {
  let result = "";
  let inTag = false;
  let isLeading = true;

  // Buffer collects output while we're unsure if whitespace is mid-line
  // or trailing.  Flushed as plain on next non-ws char, as marked on \n/EOF.
  let rawBuf = "";
  let markedBuf = "";

  function flushMid() {
    if (rawBuf) {
      result += rawBuf;
      rawBuf = "";
      markedBuf = "";
    }
  }
  function flushTrailing() {
    if (markedBuf) {
      result += markedBuf;
      rawBuf = "";
      markedBuf = "";
    }
  }

  for (let i = 0; i < html.length; i++) {
    const ch = html[i]!;

    if (ch === "<") {
      inTag = true;
      // Tags pass through — into buffer if buffering, else direct
      if (rawBuf) {
        rawBuf += ch;
        markedBuf += ch;
      } else {
        result += ch;
      }
    } else if (ch === ">") {
      inTag = false;
      if (rawBuf) {
        rawBuf += ch;
        markedBuf += ch;
      } else {
        result += ch;
      }
    } else if (inTag) {
      if (rawBuf) {
        rawBuf += ch;
        markedBuf += ch;
      } else {
        result += ch;
      }
    } else if (ch === "\n") {
      flushTrailing();
      result += ch;
      isLeading = true;
    } else if (ch === " " || ch === "\t") {
      const marked =
        ch === " "
          ? '<span class="ws-sp"> </span>'
          : '<span class="ws-tb">\t</span>';
      if (isLeading) {
        result += marked;
      } else {
        rawBuf += ch;
        markedBuf += marked;
      }
    } else {
      flushMid();
      isLeading = false;
      result += ch;
    }
  }
  flushTrailing();
  return result;
}

/** Compute leading-indentation column count for each line of source text. */
function computeLineIndents(content: string, tabSize: number): number[] {
  return content.split("\n").map((line) => {
    let col = 0;
    for (const ch of line) {
      if (ch === " ") col++;
      else if (ch === "\t") col += tabSize - (col % tabSize);
      else break;
    }
    return col;
  });
}

/**
 * Inject a `--indent` CSS custom property into each shiki `<span class="line">`
 * so that a `::before` pseudo-element can draw indent guides only as wide as
 * the leading whitespace of that line.
 */
function applyIndentGuides(html: string, indents: number[]): string {
  let lineIdx = 0;
  return html.replace(/<span class="line">/g, (match) => {
    const indent = indents[lineIdx++] ?? 0;
    if (indent > 0) {
      return `<span class="line" style="--indent:${indent}ch">`;
    }
    return match;
  });
}

function DownloadButton({
  repoId,
  changelistNumber,
  filePath,
}: {
  repoId: string;
  changelistNumber: number;
  filePath: string;
}) {
  const href = `/api/file/download?repoId=${encodeURIComponent(repoId)}&cl=${changelistNumber}&path=${encodeURIComponent(filePath)}`;

  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z" />
      </svg>
      Download
    </a>
  );
}

function CodeBlock({
  content,
  filePath,
  showWhitespace,
  tabSize,
}: {
  content: string;
  filePath: string;
  showWhitespace: boolean;
  tabSize: number;
}) {
  const rawId = useId();
  // useId returns ":r0:" etc — strip colons for a valid CSS id
  const scopeId = `cb${rawId.replace(/:/g, "")}`;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lang = getLanguageFromPath(filePath);

    codeToHtml(content, { lang, theme: "github-dark-default" })
      .then((result) => {
        if (!cancelled) {
          let processed = result;
          if (showWhitespace) {
            processed = applyWhitespaceMarkers(processed);
            const indents = computeLineIndents(content, tabSize);
            processed = applyIndentGuides(processed, indents);
          }
          // Strip newlines between .line spans AFTER whitespace marking
          // (the marker function needs \n to detect line boundaries)
          processed = processed.replace(
            /<\/span>\n<span class="line"/g,
            '</span><span class="line"',
          );
          setHtml(processed);
        }
      })
      .catch(() => {
        //
      });

    return () => {
      cancelled = true;
    };
  }, [content, filePath, showWhitespace, tabSize]);

  // Scoped CSS so styles only affect this code block
  const css = `
    #${scopeId} pre { tab-size: ${tabSize}; }
    #${scopeId} .line {
      display: block;
      position: relative;
      min-height: 1lh;
    }
    ${
      showWhitespace
        ? `
    #${scopeId} .ws-sp {
      position: relative;
    }
    #${scopeId} .ws-sp::after {
      content: '·';
      position: absolute;
      left: 0; top: 0;
      color: rgba(200,200,200,0.2);
      pointer-events: none;
    }
    #${scopeId} .ws-tb {
      position: relative;
    }
    #${scopeId} .ws-tb::after {
      content: '→';
      position: absolute;
      left: calc(${(tabSize - 1) * 0.5} * 1ch); top: 0;
      color: rgba(200,200,200,0.2);
      pointer-events: none;
    }
    #${scopeId} .line[style*="--indent"]::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--indent);
      background-image: repeating-linear-gradient(
        to right,
        rgba(255,255,255,0.07) 0,
        rgba(255,255,255,0.07) 1px,
        transparent 1px,
        transparent calc(${tabSize} * 1ch)
      );
      pointer-events: none;
    }
    `
        : ""
    }
  `;

  return (
    <div id={scopeId} className="overflow-x-auto">
      {}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {html ? (
        <div
          className="[&_code]:text-sm [&_pre]:!m-0 [&_pre]:!rounded-none [&_pre]:!p-4 [&_pre]:text-sm [&_pre]:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 overflow-x-auto rounded-none bg-[#0d1117] p-4 text-sm leading-relaxed text-[#e6edf3]">
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
}

export default function FileViewerPage() {
  const params = useParams<{
    orgName: string;
    repoName: string;
    filePath: string[];
  }>();
  const orgName = decodeURIComponent(params.orgName);
  const repoName = decodeURIComponent(params.repoName);
  const filePath = params.filePath.map(decodeURIComponent).join("/");
  const fileName = filePath.split("/").pop() ?? filePath;
  useDocumentTitle(`${fileName} · ${repoName} in ${orgName}`);

  // Settings — read from localStorage after mount to avoid SSR mismatch
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [tabSize, setTabSize] = useState(4);

  useEffect(() => {
    const storedWs = localStorage.getItem("viewer-show-whitespace");
    if (storedWs !== null) setShowWhitespace(storedWs === "true");
    const storedTs = parseInt(
      localStorage.getItem("viewer-tab-size") ?? "",
      10,
    );
    if (!isNaN(storedTs) && storedTs >= 1 && storedTs <= 16)
      setTabSize(storedTs);
  }, []);

  const { data: org } = api.org.getOrg.useQuery({
    id: orgName,
    idIsName: true,
  });
  const repoData = org?.repos?.find(
    (r: { name: string }) => r.name === repoName,
  );

  const { data: branches } = api.branch.listBranches.useQuery(
    { repoId: repoData?.id ?? "" },
    { enabled: !!repoData?.id },
  );

  const defaultBranch = branches?.find((b) => b.isDefault);

  const {
    data: fileData,
    isLoading,
    error,
  } = api.file.readFileContent.useQuery(
    {
      repoId: repoData?.id ?? "",
      changelistNumber: defaultBranch?.headNumber ?? 0,
      filePath,
    },
    { enabled: !!repoData?.id && defaultBranch?.headNumber != null },
  );

  const basePath = `/${orgName}/${repoName}`;
  const pathParts = filePath.split("/");

  if (!repoData) {
    return (
      <EmptyState
        title="Repository not found"
        description={`Could not find ${orgName}/${repoName}.`}
      />
    );
  }

  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-1 text-sm">
        <a
          href={basePath}
          className="rounded px-1.5 py-0.5 text-[var(--color-text-link)] transition-colors hover:bg-[var(--color-bg-surface)] hover:underline"
        >
          /
        </a>
        {pathParts.map((part, i) => {
          const isLast = i === pathParts.length - 1;
          const folderPath = pathParts.slice(0, i + 1).join("/");
          return (
            <span key={folderPath} className="flex items-center gap-1">
              <span className="text-[var(--color-text-muted)]">/</span>
              {isLast ? (
                <span className="rounded px-1.5 py-0.5 font-medium text-[var(--color-text-primary)]">
                  {part}
                </span>
              ) : (
                <a
                  href={`${basePath}?folder=${encodeURIComponent(pathParts.slice(0, i + 1).join("/"))}`}
                  className="rounded px-1.5 py-0.5 text-[var(--color-text-link)] transition-colors hover:bg-[var(--color-bg-surface)] hover:underline"
                >
                  {part}
                </a>
              )}
            </span>
          );
        })}
      </div>

      {/* Header bar */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="text-[var(--color-text-muted)]"
          >
            <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
          </svg>
          <span className="font-medium text-[var(--color-text-primary)]">
            {fileName}
          </span>
          {defaultBranch && <span>· CL #{defaultBranch.headNumber}</span>}
          {fileData && !fileData.isBinary && fileData.size > 0 && (
            <span>· {formatSize(fileData.size)}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Tab size */}
          <label className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)]">
            <span className="select-none">Tab:</span>
            <input
              type="number"
              min={1}
              max={16}
              value={tabSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1 && v <= 16) {
                  setTabSize(v);
                  localStorage.setItem("viewer-tab-size", String(v));
                }
              }}
              className="w-12 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-1.5 py-1 text-center text-sm text-[var(--color-text-primary)] focus:ring-1 focus:ring-[var(--color-accent)] focus:outline-none"
            />
          </label>

          {/* Whitespace toggle */}
          <button
            type="button"
            title={showWhitespace ? "Hide whitespace" : "Show whitespace"}
            onClick={() => {
              const next = !showWhitespace;
              setShowWhitespace(next);
              localStorage.setItem("viewer-show-whitespace", String(next));
            }}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
              showWhitespace
                ? "bg-[var(--color-accent)] text-white"
                : "border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)]"
            }`}
          >
            <span className="font-mono leading-none" aria-hidden>
              ·→
            </span>
            Whitespace
          </button>

          {repoData?.id && defaultBranch?.headNumber != null && (
            <DownloadButton
              repoId={repoData.id}
              changelistNumber={defaultBranch.headNumber}
              filePath={filePath}
            />
          )}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
          Loading file…
        </div>
      ) : error ? (
        <EmptyState title="Failed to load file" description={error.message} />
      ) : fileData?.isBinary ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-8">
            <svg
              width="48"
              height="48"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="text-[var(--color-text-muted)]"
            >
              <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
            </svg>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Binary file — cannot display contents
            </p>
          </div>
        </Card>
      ) : fileData?.tooLarge ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-8">
            <p className="text-sm text-[var(--color-text-secondary)]">
              File is too large to display ({formatSize(fileData.size)})
            </p>
          </div>
        </Card>
      ) : fileData?.content != null ? (
        <Card padding={false} className="overflow-hidden">
          <CodeBlock
            content={fileData.content}
            filePath={filePath}
            showWhitespace={showWhitespace}
            tabSize={tabSize}
          />
        </Card>
      ) : (
        <EmptyState
          title="Empty file"
          description="This file has no content."
        />
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
