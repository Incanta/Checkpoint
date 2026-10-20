// Redaction for log bundles attached to bug reports. It strips credentials
// (tokens, keys, passwords, cookies), email addresses, and the OS username in
// home-directory paths, and keeps everything else, repo and workspace paths
// included, since those are what a bug report is debugged from.
//
// This module must stay dependency-free and browser-safe, like issue-refs.ts:
// the caller passes in the home directory and username rather than this
// reading them from `os`.

export const REDACTED = "[REDACTED]";

export interface RedactOptions {
  /**
   * Exact values to remove wherever they appear, such as the API tokens the
   * daemon holds. Values shorter than 8 characters are ignored, since they
   * would match ordinary text.
   */
  secrets?: string[];
  /**
   * Home directories to anonymize literally (os.homedir()). Needed for a home
   * outside the usual C:\Users, /home, and /Users roots, or a username with a
   * space in it, which the generic path rule cannot see the end of.
   */
  homeDirs?: string[];
}

// Names (JSON and YAML keys, env vars, query parameters, CLI flags) whose
// value is a credential. Matched anywhere in the name, case-insensitively, so
// "apiToken", "s3_secret_access_key", and "X-Amz-Security-Token" all count.
const SENSITIVE_NAME =
  /passw(?:or)?d|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|signing[-_]?key|credential|authorization|cookie|signature|session[-_]?id/i;

// Query parameters additionally hide these exact names. Bare "key" and "code"
// are too common as JSON keys (an S3 object key, an error code) to hide there.
const SENSITIVE_PARAM = /^(?:key|sig|code)$/i;

/** Whether a key, variable, or flag with this name holds a credential. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

function isSensitiveParam(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Keep the raw name.
  }
  return SENSITIVE_NAME.test(decoded) || SENSITIVE_PARAM.test(decoded);
}

function alreadyRedacted(value: string): boolean {
  return value.includes("[REDACTED");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A home-directory path segment ends at a separator, a quote, whitespace, or
// punctuation that cannot be part of a Windows or POSIX user name.
const SEGMENT_END = `(?=$|[\\\\/\\s"'<>:;,)\\]}|])`;

const WINDOWS_HOME = new RegExp(
  String.raw`([A-Za-z]:(?:\\{1,4}|/)(?:Users|Documents and Settings)(?:\\{1,4}|/))` +
    String.raw`(?!(?:Public|Default|Default User|All Users|\[user\])` +
    SEGMENT_END +
    ")" +
    String.raw`([^\\/\s"'<>|:*?]+)`,
  "gi",
);

const POSIX_HOME = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(/(?:home|Users)/)` +
    String.raw`(?!(?:Shared|\[user\])` +
    SEGMENT_END +
    ")" +
    String.raw`([^/\s"'<>:;,)\]}]+)`,
  "g",
);

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

function redactHomePaths(text: string): string {
  return text
    .replace(WINDOWS_HOME, (_m, prefix: string) => `${prefix}[user]`)
    .replace(POSIX_HOME, (_m, prefix: string) => `${prefix}[user]`);
}

/**
 * Redacts text and structured values. One instance numbers email addresses
 * as it meets them, so the same address gets the same placeholder in every
 * file of a bundle and different people stay distinguishable.
 */
export class Redactor {
  private readonly emails = new Map<string, string>();
  private readonly literals: { pattern: RegExp; replacement: string }[] = [];

  constructor(options: RedactOptions = {}) {
    const secrets = [...new Set(options.secrets ?? [])]
      .filter((s) => typeof s === "string" && s.length >= 8)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      this.literals.push({
        pattern: new RegExp(escapeRegExp(secret), "g"),
        replacement: REDACTED,
      });
    }

    for (const home of options.homeDirs ?? []) {
      if (!home || home.length < 3) continue;
      // The path as written, JSON-escaped, and with forward slashes. Windows
      // paths are case-insensitive, so the match is too.
      const spellings = new Set([
        home,
        home.replace(/\\/g, "\\\\"),
        home.replace(/\\/g, "/"),
      ]);
      for (const spelling of spellings) {
        // A home under a usual root keeps the root; the whole last segment
        // is the user name, spaces and all. Anywhere else, the whole path
        // goes.
        const root =
          /^(.*(?:Users|Documents and Settings|home)(?:\\{1,4}|\/))[^\\/]+$/i.exec(
            spelling,
          );
        this.literals.push({
          pattern: new RegExp(escapeRegExp(spelling) + SEGMENT_END, "gi"),
          replacement: root ? `${root[1]}[user]` : "[home]",
        });
      }
    }
  }

  /** The placeholder standing in for an email address. */
  private emailPlaceholder(email: string): string {
    const key = email.toLowerCase();
    let placeholder = this.emails.get(key);
    if (!placeholder) {
      placeholder = `[email-${this.emails.size + 1}]`;
      this.emails.set(key, placeholder);
    }
    return placeholder;
  }

  /** Redacts free text: a log line, a config file, a command line. */
  redactText(text: string): string {
    if (!text) return text;
    let out = text;

    // PEM private keys, whole.
    out = out.replace(
      /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
      "[REDACTED:private-key]",
    );

    for (const { pattern, replacement } of this.literals) {
      out = out.replace(pattern, replacement);
    }

    // Authorization headers keep their scheme so "Basic" vs "Bearer" stays
    // visible.
    out = out.replace(
      /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|digest|token|negotiate)\s+)?([^\s"',;]+)/gi,
      (_m, name: string, sep: string, scheme: string | undefined) =>
        `${name}${sep}${scheme ? `${scheme} ` : ""}${REDACTED}`,
    );

    // Cookie and Set-Cookie headers: the whole value.
    out = out.replace(
      /\b(set-cookie|cookie)(["']?\s*[:=]\s*)(["']?)([^\r\n"']*)/gi,
      (m, name: string, sep: string, quote: string, value: string) =>
        !value.trim() || alreadyRedacted(value)
          ? m
          : `${name}${sep}${quote}${REDACTED}`,
    );

    // A bearer token anywhere. Eight characters minimum so prose such as
    // "bearer token missing" is left alone.
    out = out.replace(
      /\b(bearer)\s+([A-Za-z0-9\-._~+/]{8,}=*)/gi,
      (_m, scheme: string) => `${scheme} ${REDACTED}`,
    );

    // JWTs (storage tokens, session tokens): three base64url parts, the
    // first of which is a JSON header and so always starts "eyJ".
    out = out.replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      "[REDACTED:jwt]",
    );

    // Well-known token formats.
    out = out.replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,})\b/g,
      "[REDACTED:token]",
    );
    out = out.replace(
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
      "[REDACTED:aws-key-id]",
    );

    // A password in a URL: scheme://user:password@host keeps the user.
    out = out.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/?#]*):([^\s@/?#]+)@/gi,
      (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
    );

    // Query and fragment parameters: ?token=, &key=, &X-Amz-Signature=.
    out = out.replace(
      /([?&#;])([^=&\s#?"'<>]+)=([^&\s#"'<>]*)/g,
      (m, sep: string, name: string, value: string) =>
        value && !alreadyRedacted(value) && isSensitiveParam(name)
          ? `${sep}${name}=${REDACTED}`
          : m,
    );

    // JSON: "password": "x", "apiToken": 123, and the same escaped inside a
    // JSON string.
    out = out.replace(
      /"([^"\\\r\n]{1,100})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/g,
      (m, name: string, sep: string, value: string) =>
        isSensitiveName(name) && value !== '""' && !alreadyRedacted(value)
          ? `"${name}"${sep}"${REDACTED}"`
          : m,
    );
    out = out.replace(
      /\\"([A-Za-z0-9_.-]{1,100})\\"(\s*:\s*)\\"((?:[^"\\]|\\[^"])*)\\"/g,
      (m, name: string, sep: string, value: string) =>
        isSensitiveName(name) && value && !alreadyRedacted(value)
          ? `\\"${name}\\"${sep}\\"${REDACTED}\\"`
          : m,
    );

    // Object literals as Node prints them: { password: 'x', user: 'y' }.
    out = out.replace(
      /([{,]\s*)([A-Za-z_$][\w$-]{0,100})(\s*:\s*)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g,
      (m, pre: string, name: string, sep: string, value: string) =>
        isSensitiveName(name) && value.length > 2 && !alreadyRedacted(value)
          ? `${pre}${name}${sep}${value[0]}${REDACTED}${value[0]}`
          : m,
    );

    // CLI flags with a separate value: --token abc, --password "x y".
    out = out.replace(
      /(^|\s)(--[A-Za-z][A-Za-z0-9-]*)(\s+)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'-][^\s]*)/g,
      (m, pre: string, flag: string, sep: string, value: string) =>
        isSensitiveName(flag) && !alreadyRedacted(value)
          ? `${pre}${flag}${sep}${REDACTED}`
          : m,
    );

    // name=value: env files, logfmt, .secrets, --flag=value.
    out = out.replace(
      /(^|[\s,;{(])(-{0,2})([A-Za-z_][A-Za-z0-9_.-]{0,100})=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s&,;"'}<>]+)/gm,
      (m, pre: string, dashes: string, name: string, value: string) =>
        isSensitiveName(name) && !alreadyRedacted(value)
          ? `${pre}${dashes}${name}=${REDACTED}`
          : m,
    );

    // name: value at the start of a line: YAML, and objects as pino-pretty
    // prints them. Only at the start of a line, so prose like "failed to
    // refresh token: timed out" keeps its message.
    out = out.replace(
      /^([ \t]*(?:-[ \t]+)?)([A-Za-z_][A-Za-z0-9_.-]{0,100})([ \t]*:[ \t]+)([^\r\n]*?)(,?)[ \t]*$/gm,
      (
        m,
        pre: string,
        name: string,
        sep: string,
        value: string,
        comma: string,
      ) => {
        const trimmed = value.trim();
        if (
          !isSensitiveName(name) ||
          !trimmed ||
          trimmed === '""' ||
          trimmed === "''" ||
          /^[|>][-+]?$/.test(trimmed) ||
          alreadyRedacted(trimmed)
        ) {
          return m;
        }
        const quote = /^["']/.test(trimmed) ? trimmed[0] : "";
        return `${pre}${name}${sep}${quote}${REDACTED}${quote}${comma}`;
      },
    );

    // Long hex strings: API tokens and `openssl rand -hex 32` keys. A file
    // name such as "<sha256>.lvi" is a content hash, not a secret, and stays.
    out = out.replace(
      /\b[0-9a-fA-F]{64,}\b(?!\.[A-Za-z0-9]{1,5}\b)/g,
      "[REDACTED:hex]",
    );

    out = out.replace(EMAIL, (email) => this.emailPlaceholder(email));

    out = redactHomePaths(out);

    return out;
  }

  /**
   * Redacts a parsed JSON value. Every value under a sensitive key is
   * replaced, nested objects included; an empty string is kept, since "not
   * set" is often the clue. Other strings go through redactText.
   */
  redactValue<T>(value: T): T {
    return this.redactNode(value, false, new WeakSet()) as T;
  }

  private redactNode(
    value: unknown,
    sensitive: boolean,
    seen: WeakSet<object>,
  ): unknown {
    if (typeof value === "string") {
      if (sensitive) return value === "" ? value : REDACTED;
      return this.redactText(value);
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return sensitive ? REDACTED : value;
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.redactNode(item, sensitive, seen));
    }
    if (value instanceof Date) {
      return value;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[this.redactText(key)] = this.redactNode(
        child,
        sensitive || isSensitiveName(key),
        seen,
      );
    }
    return out;
  }

  /**
   * Redacts log file content. Lines that are JSON objects (pino's file
   * format) are parsed so keys are matched exactly; other lines are treated
   * as text. Line endings are kept.
   */
  redactLog(text: string): string {
    return text
      .split(/(\r?\n)/)
      .map((part) => {
        if (part === "\n" || part === "\r\n") return part;
        const trimmed = part.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object") {
              return JSON.stringify(this.redactValue(parsed));
            }
          } catch {
            // Not JSON after all.
          }
        }
        return this.redactText(part);
      })
      .join("");
  }
}

/** One-shot text redaction. Use a shared Redactor for a multi-file bundle. */
export function redactText(text: string, options?: RedactOptions): string {
  return new Redactor(options).redactText(text);
}
