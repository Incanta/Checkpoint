import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import {
  createHighlighter,
  type BundledLanguage,
  type LanguageRegistration,
} from "shiki";
import { normalizeTheme } from "shiki/core";
import githubDarkDefault from "shiki/themes/github-dark-default.mjs";
import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco";
import angelscriptGrammar from "./angelscript.tmLanguage.json";

// The diff editors import only Monaco's editor.api, which ships no language
// tokenizers. Highlighting comes from shiki's TextMate grammars instead, the
// same ones the web app's file viewer uses, so both look alike.

/** Monaco theme name for every diff editor. Monaco themes are global. */
export const MONACO_THEME = "github-dark-default";

/** Language id for files we don't highlight. */
export const PLAIN_TEXT = "plaintext";

// Grammars shiki doesn't bundle. The web app keeps a mirror of the
// Angelscript grammar (src/app/src/lib/syntax/).
const CUSTOM_LANGUAGES: LanguageRegistration[] = [
  angelscriptGrammar as unknown as LanguageRegistration,
];

// File extension (lowercase) -> shiki language id.
const EXTENSION_LANGUAGES: Record<string, string> = {
  as: "angelscript",
  c: "c",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  inl: "cpp",
  cs: "csharp",
  usf: "hlsl",
  ush: "hlsl",
  hlsl: "hlsl",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  uproject: "jsonc",
  uplugin: "jsonc",
  css: "css",
  html: "html",
  xml: "xml",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  py: "python",
  lua: "lua",
  rs: "rust",
  go: "go",
  java: "java",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  bat: "bat",
  cmd: "bat",
  ps1: "powershell",
  cmake: "cmake",
};

// Whole file name (lowercase) -> shiki language id, for files without a
// telling extension.
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  "cmakelists.txt": "cmake",
};

/** Picks the Monaco language id for a repo path, or PLAIN_TEXT. */
export function getLanguageFromPath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const byName = FILENAME_LANGUAGES[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot === -1) return PLAIN_TEXT;
  return EXTENSION_LANGUAGES[name.slice(dot + 1)] ?? PLAIN_TEXT;
}

let registered = false;
let ready: Promise<void> | null = null;

/**
 * Call before creating a diff editor. Synchronously defines the theme and
 * language ids so editors and models can be created right away, then loads
 * the grammars in the background. Open models re-tokenize when they arrive.
 */
export function prepareMonacoHighlighting(): Promise<void> {
  const languageIds = new Set([
    ...Object.values(EXTENSION_LANGUAGES),
    ...Object.values(FILENAME_LANGUAGES),
  ]);

  if (!registered) {
    registered = true;
    // Define the theme now so editors created before the grammars load don't
    // fall back to Monaco's light theme.
    monaco.editor.defineTheme(
      MONACO_THEME,
      textmateThemeToMonacoTheme(
        normalizeTheme(githubDarkDefault),
      ) as monaco.editor.IStandaloneThemeData,
    );
    const known = new Set(
      monaco.languages.getLanguages().map((l: { id: string }) => l.id),
    );
    for (const id of languageIds) {
      if (!known.has(id)) monaco.languages.register({ id });
    }
  }

  ready ??= (async (): Promise<void> => {
    const custom = new Set(CUSTOM_LANGUAGES.map((l) => l.name));
    const bundled = [...languageIds].filter(
      (id) => !custom.has(id),
    ) as BundledLanguage[];
    const highlighter = await createHighlighter({
      themes: [githubDarkDefault],
      langs: [...bundled, ...CUSTOM_LANGUAGES],
    });
    // Registers a tokens provider for every loaded language and makes
    // MONACO_THEME the active theme.
    shikiToMonaco(highlighter, monaco);
  })().catch((err) => {
    console.error("Failed to load syntax highlighting", err);
  });

  return ready;
}
