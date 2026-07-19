import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "chk-desktop-theme";

/**
 * Resolves the starting theme. A pre-paint script in index.html has already
 * stamped `data-theme` on <html> from localStorage / OS preference to avoid a
 * flash, so prefer that; fall back to storage, then dark.
 */
function getInitialTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* localStorage unavailable */
  }
  return "dark";
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage unavailable */
    }
    // Keep the native window-controls overlay (Windows/Linux) in sync with the
    // titlebar color. getComputedStyle forces a style resolution so the values
    // reflect the just-applied theme.
    try {
      const styles = getComputedStyle(document.documentElement);
      const color = styles.getPropertyValue("--bg-secondary").trim();
      const symbolColor = styles.getPropertyValue("--text-primary").trim();
      if (color && symbolColor) {
        window.electron?.ipcRenderer.sendMessage("window:set-titlebar-overlay", {
          color,
          symbolColor,
        });
      }
    } catch {
      /* Non-Electron environment or no overlay; ignore. */
    }
  }, [theme]);

  const value: ThemeContextValue = {
    theme,
    setTheme: setThemeState,
    toggleTheme: () =>
      setThemeState((current) => (current === "dark" ? "light" : "dark")),
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
