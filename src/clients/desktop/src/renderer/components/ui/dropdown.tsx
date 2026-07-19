import { useEffect, useRef, useState, type ReactNode } from "react";

interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
}

export function Dropdown({
  trigger,
  children,
  align = "right",
}: DropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer border-0 bg-transparent p-0"
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`absolute top-full z-50 mt-1 min-w-[200px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-overlay)] py-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface DropdownItemProps {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}

export function DropdownItem({
  children,
  onClick,
  danger,
}: DropdownItemProps): React.ReactElement {
  const cls = `flex w-full items-center gap-2 border-0 bg-transparent px-4 py-2 text-sm transition-colors ${
    danger
      ? "text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
      : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-surface)]"
  }`;

  return (
    <button type="button" onClick={onClick} className={`${cls} cursor-pointer`}>
      {children}
    </button>
  );
}

export function DropdownDivider(): React.ReactElement {
  return <div className="my-1 border-t border-[var(--color-border-default)]" />;
}
