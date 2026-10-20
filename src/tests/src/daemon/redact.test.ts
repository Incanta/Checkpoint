/**
 * The redaction applied to bug-report log bundles (src/core/common/src/utils/
 * redact.ts). Each rule gets the shapes it is expected to catch, the near
 * misses it must leave alone (so debugging context survives), and the
 * interactions between rules.
 */
import { describe, expect, it } from "vitest";

import {
  REDACTED,
  Redactor,
  isSensitiveName,
  redactText,
} from "../../../core/common/src/utils/redact.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXBvIjoiYWJjIiwiZXhwIjoxfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const HEX64 =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("isSensitiveName", () => {
  it.each([
    "password",
    "PASSWORD",
    "db_passwd",
    "passphrase",
    "secret",
    "clientSecret",
    "s3_secret_access_key",
    "token",
    "apiToken",
    "refresh_token",
    "X-Amz-Security-Token",
    "apiKey",
    "api_key",
    "API-KEY",
    "accessKeyId",
    "r2_access_key_id",
    "privateKey",
    "signing-key",
    "storage_signing_key",
    "credentials",
    "X-Amz-Credential",
    "Authorization",
    "cookie",
    "Set-Cookie",
    "X-Amz-Signature",
    "sessionId",
  ])("treats %s as sensitive", (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each([
    "path",
    "localPath",
    "repoId",
    "daemonId",
    "changelistNumber",
    "email",
    "key",
    "code",
    "msg",
    "level",
    "hostname",
  ])("leaves %s alone", (name) => {
    expect(isSensitiveName(name)).toBe(false);
  });
});

describe("bearer tokens and Authorization headers", () => {
  it("redacts a raw header line and keeps the scheme", () => {
    expect(redactText("Authorization: Bearer abcdef0123456789")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it("keeps Basic and other schemes visible", () => {
    expect(redactText("authorization: Basic dXNlcjpwYXNz")).toBe(
      `authorization: Basic ${REDACTED}`,
    );
  });

  it("redacts a header with no scheme", () => {
    expect(redactText("Authorization=abc123def456")).toBe(
      `Authorization=${REDACTED}`,
    );
  });

  it("redacts the header inside JSON", () => {
    expect(
      redactText('{"headers":{"authorization":"Bearer abc.def-123456"}}'),
    ).toBe(`{"headers":{"authorization":"Bearer ${REDACTED}"}}`);
  });

  it("redacts Proxy-Authorization", () => {
    expect(redactText("Proxy-Authorization: Basic Zm9vOmJhcg==")).toBe(
      `Proxy-Authorization: Basic ${REDACTED}`,
    );
  });

  it("redacts a bearer token outside a header", () => {
    expect(redactText("sending Bearer 0123456789abcdefXYZ to server")).toBe(
      `sending Bearer ${REDACTED} to server`,
    );
  });

  it("leaves prose about bearer tokens alone", () => {
    expect(redactText("missing bearer token")).toBe("missing bearer token");
  });

  it("leaves an empty JSON header value alone", () => {
    expect(redactText('{"authorization":""}')).toBe('{"authorization":""}');
  });
});

describe("cookies", () => {
  it("redacts a Cookie header to the end of the line", () => {
    expect(
      redactText(
        "Cookie: better-auth.session_token=abc.def; theme=dark\nnext line",
      ),
    ).toBe(`Cookie: ${REDACTED}\nnext line`);
  });

  it("redacts Set-Cookie", () => {
    expect(redactText("Set-Cookie: sid=abc123; Path=/; HttpOnly")).toBe(
      `Set-Cookie: ${REDACTED}`,
    );
  });

  it("redacts a cookie inside JSON and keeps the quotes balanced", () => {
    expect(redactText('{"cookie":"a=b; c=d","x":1}')).toBe(
      `{"cookie":"${REDACTED}","x":1}`,
    );
  });

  it("leaves the word cookies alone mid-sentence", () => {
    expect(redactText("found cookies: 3")).toBe("found cookies: 3");
  });
});

describe("JWTs", () => {
  it("redacts a bare JWT", () => {
    expect(redactText(`storage token ${JWT} issued`)).toBe(
      "storage token [REDACTED:jwt] issued",
    );
  });

  it("redacts an unsigned JWT (empty signature)", () => {
    expect(redactText("t=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.")).toBe(
      "t=[REDACTED:jwt]",
    );
  });

  it("redacts a JWT in a URL path", () => {
    expect(redactText(`https://s.example.com/x/${JWT}/blocks`)).toBe(
      "https://s.example.com/x/[REDACTED:jwt]/blocks",
    );
  });

  it("leaves base64 that is not a JWT alone", () => {
    expect(redactText("eyJ alone and a.b.c")).toBe("eyJ alone and a.b.c");
  });
});

describe("Checkpoint API tokens, signing keys, and long hex", () => {
  it("redacts a 64-hex API token on its own", () => {
    expect(redactText(`token ${HEX64} saved`)).toBe(
      "token [REDACTED:hex] saved",
    );
  });

  it("redacts a longer hex secret", () => {
    expect(redactText(`k ${HEX64}${HEX64}`)).toBe("k [REDACTED:hex]");
  });

  it("keeps a version index file name, which is a content hash", () => {
    const line = `downloading versions/${HEX64}.lvi`;
    expect(redactText(line)).toBe(line);
  });

  it("keeps 32-hex MD5s and 40-hex SHA-1s", () => {
    const md5 = "d41d8cd98f00b204e9800998ecf8427e";
    const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    expect(redactText(`${md5} ${sha1}`)).toBe(`${md5} ${sha1}`);
  });

  it("does not redact hex embedded in a longer word", () => {
    const word = `x${HEX64}y`;
    expect(redactText(word)).toBe(word);
  });

  it("redacts the storage signing key in a .secrets file", () => {
    expect(redactText("storage_signing_key=supersecretvalue1234")).toBe(
      `storage_signing_key=${REDACTED}`,
    );
  });

  it("redacts the signing key in YAML", () => {
    expect(redactText("jwt:\n  signing-key: my-long-signing-key-value")).toBe(
      `jwt:\n  signing-key: ${REDACTED}`,
    );
  });

  it("redacts exact secrets passed in, wherever they appear", () => {
    const r = new Redactor({ secrets: ["tok_abcdefgh"] });
    expect(r.redactText("x=tok_abcdefgh, y=tok_abcdefgh")).toBe(
      `x=${REDACTED}, y=${REDACTED}`,
    );
  });

  it("ignores secrets too short to match safely", () => {
    const r = new Redactor({ secrets: ["abc", ""] });
    expect(r.redactText("abc abc")).toBe("abc abc");
  });

  it("redacts a secret containing regex metacharacters literally", () => {
    const r = new Redactor({ secrets: ["a+b*c?(d)[e]"] });
    expect(r.redactText("v a+b*c?(d)[e] v")).toBe(`v ${REDACTED} v`);
  });

  it("replaces the longer of two overlapping secrets whole", () => {
    const r = new Redactor({ secrets: ["abcdefgh", "abcdefghijkl"] });
    expect(r.redactText("abcdefghijkl")).toBe(REDACTED);
  });
});

describe("S3, R2, and other provider keys", () => {
  it("redacts an AWS access key id", () => {
    expect(redactText("key AKIAIOSFODNN7EXAMPLE used")).toBe(
      "key [REDACTED:aws-key-id] used",
    );
  });

  it("redacts a temporary (ASIA) key id", () => {
    expect(redactText("ASIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws-key-id]");
  });

  it("redacts S3 and R2 secrets in env and .secrets form", () => {
    expect(
      redactText(
        "s3_access_key_id=abc123\ns3_secret_access_key=xyz/987+q\nr2_api_token=zzz",
      ),
    ).toBe(
      `s3_access_key_id=${REDACTED}\ns3_secret_access_key=${REDACTED}\nr2_api_token=${REDACTED}`,
    );
  });

  it("redacts AWS env vars", () => {
    expect(
      redactText("AWS_SECRET_ACCESS_KEY=abc AWS_SESSION_TOKEN=def AWS_REGION=x"),
    ).toBe(
      `AWS_SECRET_ACCESS_KEY=${REDACTED} AWS_SESSION_TOKEN=${REDACTED} AWS_REGION=x`,
    );
  });

  it("redacts GitHub, Slack, and Stripe token formats", () => {
    expect(
      redactText(
        "ghp_0123456789abcdefghijABCDEFGHIJ0123 xoxb-1234567890-abc sk_live_0123456789abcd whsec_0123456789abcd",
      ),
    ).toBe(
      "[REDACTED:token] [REDACTED:token] [REDACTED:token] [REDACTED:token]",
    );
  });
});

describe("URLs", () => {
  it("redacts the password in user:pass@ and keeps the user", () => {
    expect(
      redactText("postgresql://checkpoint:hunter2@postgres:5432/checkpoint"),
    ).toBe(`postgresql://checkpoint:${REDACTED}@postgres:5432/checkpoint`);
  });

  it("redacts a password with no user", () => {
    expect(redactText("redis://:p4ss@cache:6379")).toBe(
      `redis://:${REDACTED}@cache:6379`,
    );
  });

  it("leaves a URL with only a user alone", () => {
    expect(redactText("ssh://deploy@host/repo")).toBe("ssh://deploy@host/repo");
  });

  it("leaves a port alone", () => {
    expect(redactText("http://localhost:13000/api")).toBe(
      "http://localhost:13000/api",
    );
  });

  it.each([
    ["token", "?token=abc123"],
    ["key", "?key=abc123"],
    ["secret", "&secret=abc123"],
    ["signature", "&signature=abc123"],
    ["sig", "&sig=abc123"],
    ["code", "?code=ABC123"],
    ["X-Amz-Signature", "&X-Amz-Signature=abcdef"],
    ["X-Amz-Credential", "&X-Amz-Credential=AKID%2F2026%2Fauto"],
    ["X-Amz-Security-Token", "&X-Amz-Security-Token=FwoG"],
    ["access_token", "#access_token=abc"],
  ])("redacts the %s query parameter", (name, query) => {
    const sep = query[0];
    expect(redactText(`https://h/p${query}`)).toBe(
      `https://h/p${sep}${name}=${REDACTED}`,
    );
  });

  it("keeps other query parameters and the order", () => {
    expect(redactText("https://h/p?branch=main&token=abc&cl=12")).toBe(
      `https://h/p?branch=main&token=${REDACTED}&cl=12`,
    );
  });

  it("matches parameter names case-insensitively and URL-decoded", () => {
    expect(redactText("https://h/p?TOKEN=abc&api%5Fkey=def")).toBe(
      `https://h/p?TOKEN=${REDACTED}&api%5Fkey=${REDACTED}`,
    );
  });

  it("keeps an empty sensitive parameter", () => {
    expect(redactText("https://h/p?token=&x=1")).toBe(
      "https://h/p?token=&x=1",
    );
  });

  it("redacts a presigned R2 URL fully", () => {
    const url =
      "https://acct.r2.cloudflarestorage.com/bucket/blocks/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20260101&X-Amz-Date=20260101T000000Z&X-Amz-Signature=deadbeef";
    expect(redactText(url)).toBe(
      `https://acct.r2.cloudflarestorage.com/bucket/blocks/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${REDACTED}&X-Amz-Date=20260101T000000Z&X-Amz-Signature=${REDACTED}`,
    );
  });
});

describe("keys in JSON, YAML, env files, and command lines", () => {
  it("redacts JSON string values of sensitive keys", () => {
    expect(
      redactText('{"user":"bob","password":"hunter2","apiKey":"k-1"}'),
    ).toBe(`{"user":"bob","password":"${REDACTED}","apiKey":"${REDACTED}"}`);
  });

  it("redacts JSON number values of sensitive keys", () => {
    expect(redactText('{"pin_password": 123456}')).toBe(
      `{"pin_password": "${REDACTED}"}`,
    );
  });

  it("handles escaped quotes inside a JSON value", () => {
    expect(redactText('{"secret":"a\\"b","n":1}')).toBe(
      `{"secret":"${REDACTED}","n":1}`,
    );
  });

  it("keeps empty JSON values, which show the setting is unset", () => {
    expect(redactText('{"token":""}')).toBe('{"token":""}');
  });

  it("redacts JSON escaped inside a JSON string", () => {
    expect(redactText('{"body":"{\\"token\\":\\"abc\\"}"}')).toBe(
      `{"body":"{\\"token\\":\\"${REDACTED}\\"}"}`,
    );
  });

  it("redacts YAML values and keeps quotes and comments' structure", () => {
    expect(
      redactText(
        'db:\n  password: "hunter 2"\n  host: postgres\nsecrets:\n  - api_key: abc',
      ),
    ).toBe(
      `db:\n  password: "${REDACTED}"\n  host: postgres\nsecrets:\n  - api_key: ${REDACTED}`,
    );
  });

  it("leaves a YAML key whose value is a nested block alone", () => {
    expect(redactText("secrets:\n  provider: local")).toBe(
      "secrets:\n  provider: local",
    );
  });

  it("leaves a YAML block scalar indicator alone", () => {
    expect(redactText("private-key: |")).toBe("private-key: |");
  });

  it("does not treat prose with a colon as a key", () => {
    const line = "Failed to refresh token: connection refused";
    expect(redactText(line)).toBe(line);
  });

  it("redacts pino-pretty object lines with trailing commas", () => {
    expect(redactText('    apiToken: "abc123",')).toBe(
      `    apiToken: "${REDACTED}",`,
    );
  });

  it("redacts Node's inspect output mid-line", () => {
    expect(redactText("got { user: 'bob', password: 'x y' } back")).toBe(
      `got { user: 'bob', password: '${REDACTED}' } back`,
    );
  });

  it("redacts --flag value and --flag=value", () => {
    expect(
      redactText("chk login --token abc123 --endpoint http://h --password=pw"),
    ).toBe(
      `chk login --token ${REDACTED} --endpoint http://h --password=${REDACTED}`,
    );
  });

  it("redacts a quoted flag value whole", () => {
    expect(redactText('run --secret "a b c" next')).toBe(
      `run --secret ${REDACTED} next`,
    );
  });

  it("redacts logfmt pairs", () => {
    expect(redactText("level=info token=abc user=bob")).toBe(
      `level=info token=${REDACTED} user=bob`,
    );
  });

  it("redacts a PEM private key block", () => {
    expect(
      redactText(
        "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nafter",
      ),
    ).toBe("before\n[REDACTED:private-key]\nafter");
  });

  it("keeps a public key", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nMIIabc\n-----END PUBLIC KEY-----";
    expect(redactText(pem)).toBe(pem);
  });
});

describe("email addresses", () => {
  it("gives each address a stable placeholder within one redactor", () => {
    const r = new Redactor();
    expect(r.redactText("a@example.com b@example.com a@example.com")).toBe(
      "[email-1] [email-2] [email-1]",
    );
    expect(r.redactText("later: b@example.com")).toBe("later: [email-2]");
  });

  it("treats addresses case-insensitively", () => {
    const r = new Redactor();
    expect(r.redactText("Mike@Example.COM mike@example.com")).toBe(
      "[email-1] [email-1]",
    );
  });

  it("handles plus addressing and subdomains", () => {
    expect(redactText("dev+ci@mail.studio.co.uk")).toBe("[email-1]");
  });

  it("redacts addresses inside JSON and angle brackets", () => {
    expect(redactText('{"email":"x@y.io"} <z@y.io>')).toBe(
      '{"email":"[email-1]"} <[email-2]>',
    );
  });

  it.each([
    "@checkpointvcs/common",
    "pino@10.1.0",
    "user@localhost",
    "node@24",
  ])("leaves %s alone", (text) => {
    expect(redactText(text)).toBe(text);
  });
});

describe("home directory usernames", () => {
  it.each([
    ["C:\\Users\\seese\\proj\\a.txt", "C:\\Users\\[user]\\proj\\a.txt"],
    ["c:\\users\\Seese", "c:\\users\\[user]"],
    ["C:/Users/seese/proj", "C:/Users/[user]/proj"],
    ["C:\\\\Users\\\\seese\\\\proj", "C:\\\\Users\\\\[user]\\\\proj"],
    ["/home/alice/work/game", "/home/[user]/work/game"],
    ["/Users/alice/Library", "/Users/[user]/Library"],
    ["path=/home/alice", "path=/home/[user]"],
    ['"/home/alice"', '"/home/[user]"'],
    ["C:\\Documents and Settings\\bob\\x", "C:\\Documents and Settings\\[user]\\x"],
  ])("anonymizes %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    "C:\\Users\\Public\\Documents",
    "C:\\Users\\Default\\x",
    "/Users/Shared/game",
    "https://host/home/alice",
    "D:\\Projects\\Game\\Content\\Maps",
    "/var/lib/checkpoint",
  ])("leaves %s alone", (input) => {
    expect(redactText(input)).toBe(input);
  });

  it("keeps workspace-relative and repo paths intact", () => {
    const line = "pulled Content/Maps/Level01.umap and Source/Game/Game.cpp";
    expect(redactText(line)).toBe(line);
  });

  it("anonymizes a configured home with a space in the name", () => {
    const r = new Redactor({ homeDirs: ["C:\\Users\\John Smith"] });
    expect(r.redactText("C:\\Users\\John Smith\\ws\\a.txt")).toBe(
      "C:\\Users\\[user]\\ws\\a.txt",
    );
    expect(r.redactText('{"p":"C:\\\\Users\\\\John Smith\\\\ws"}')).toBe(
      '{"p":"C:\\\\Users\\\\[user]\\\\ws"}',
    );
    expect(r.redactText("C:/Users/John Smith/ws")).toBe("C:/Users/[user]/ws");
  });

  it("replaces a non-standard configured home with [home]", () => {
    const r = new Redactor({ homeDirs: ["/srv/people/bob"] });
    expect(r.redactText("/srv/people/bob/ws/x")).toBe("[home]/ws/x");
  });

  it("does not let a configured home match a longer name", () => {
    const r = new Redactor({ homeDirs: ["/srv/bob"] });
    expect(r.redactText("/srv/bobby/x")).toBe("/srv/bobby/x");
  });
});

describe("redactValue", () => {
  it("redacts values under sensitive keys, nested objects included", () => {
    const r = new Redactor();
    expect(
      r.redactValue({
        user: { name: "bob", email: "bob@studio.dev" },
        apiToken: "abc",
        secrets: { db: "x", nested: { list: ["a", 1] } },
        tokenCount: 3,
        hasPassword: true,
        empty: { password: "" },
      }),
    ).toEqual({
      user: { name: "bob", email: "[email-1]" },
      apiToken: REDACTED,
      secrets: { db: REDACTED, nested: { list: [REDACTED, REDACTED] } },
      tokenCount: REDACTED,
      hasPassword: true,
      empty: { password: "" },
    });
  });

  it("runs ordinary strings through the text rules", () => {
    const r = new Redactor();
    expect(
      r.redactValue({ msg: "GET https://h/?token=abc", path: "/home/al/x" }),
    ).toEqual({ msg: `GET https://h/?token=${REDACTED}`, path: "/home/[user]/x" });
  });

  it("redacts keys that are emails", () => {
    const r = new Redactor();
    expect(r.redactValue({ "a@b.io": 1 })).toEqual({ "[email-1]": 1 });
  });

  it("survives cycles", () => {
    const r = new Redactor();
    const a: Record<string, unknown> = { x: 1 };
    a["self"] = a;
    expect(r.redactValue(a)).toEqual({ x: 1, self: "[Circular]" });
  });

  it("keeps null, booleans, and non-sensitive numbers", () => {
    const r = new Redactor();
    expect(r.redactValue({ a: null, b: false, c: 4 })).toEqual({
      a: null,
      b: false,
      c: 4,
    });
  });
});

describe("redactLog", () => {
  it("parses pino JSON lines and keeps CRLF line endings", () => {
    const r = new Redactor();
    const input =
      '{"level":30,"msg":"login","token":"abc","email":"a@b.io"}\r\nplain token=abc\r\n';
    expect(r.redactLog(input)).toBe(
      `{"level":30,"msg":"login","token":"${REDACTED}","email":"[email-1]"}\r\nplain token=${REDACTED}\r\n`,
    );
  });

  it("falls back to text for a line that only looks like JSON", () => {
    const r = new Redactor();
    expect(r.redactLog('{not json, "password":"x"}')).toBe(
      `{not json, "password":"${REDACTED}"}`,
    );
  });

  it("redacts a nested err object in a pino line", () => {
    const r = new Redactor();
    const line = JSON.stringify({
      level: 50,
      err: {
        message: "401 at https://h/api?key=zz",
        config: { headers: { Authorization: "Bearer abcdefghijk" } },
      },
    });
    expect(JSON.parse(r.redactLog(line))).toEqual({
      level: 50,
      err: {
        message: `401 at https://h/api?key=${REDACTED}`,
        config: { headers: { Authorization: REDACTED } },
      },
    });
  });

  it("returns empty input unchanged", () => {
    expect(new Redactor().redactLog("")).toBe("");
  });
});

describe("idempotence", () => {
  it.each([
    "Authorization: Bearer abcdefghijkl",
    '{"password":"x","cookie":"a=b"}',
    "https://u:p@h/?token=abc",
    "password: hunter2",
    `t ${JWT} ${HEX64}`,
    "C:\\Users\\seese\\x a@b.io",
  ])("redacting twice changes nothing more: %s", (input) => {
    const once = redactText(input);
    expect(redactText(once)).toBe(once);
  });
});
