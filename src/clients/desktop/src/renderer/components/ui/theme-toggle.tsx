import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSun } from "@fortawesome/free-solid-svg-icons/faSun";
import { faMoon } from "@fortawesome/free-solid-svg-icons/faMoon";
import { useTheme } from "../../theme";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({
  className = "",
}: ThemeToggleProps): React.ReactElement {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)] ${className}`}
    >
      <FontAwesomeIcon icon={isDark ? faSun : faMoon} />
    </button>
  );
}
