import { getSingletonHighlighter, type LanguageRegistration } from "shiki/bundle/full";
import angelscriptGrammar from "./angelscript.tmLanguage.json";

// Grammars shiki doesn't bundle. Each is loaded into the shared highlighter
// the first time it's needed. desktop has a mirror of the Angelscript grammar
// (src/clients/desktop/src/renderer/syntax/).
const CUSTOM_LANGUAGES: Record<string, LanguageRegistration> = {
  angelscript: angelscriptGrammar as unknown as LanguageRegistration,
};

const THEME = "github-dark-default";

/**
 * Highlights `code` as HTML with shiki, loading bundled or custom grammars on
 * demand. Unknown languages fall back to plain text.
 */
export async function highlightToHtml(code: string, lang: string): Promise<string> {
  const highlighter = await getSingletonHighlighter({ themes: [THEME] });
  const custom = CUSTOM_LANGUAGES[lang];
  if (custom) {
    if (!highlighter.getLoadedLanguages().includes(lang)) {
      await highlighter.loadLanguage(custom);
    }
  } else if (lang !== "text") {
    try {
      await highlighter.loadLanguage(lang as Parameters<typeof highlighter.loadLanguage>[0]);
    } catch {
      lang = "text";
    }
  }
  return highlighter.codeToHtml(code, { lang, theme: THEME });
}
