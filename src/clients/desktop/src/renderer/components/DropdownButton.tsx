import React, { useRef, useState, useEffect, useCallback } from "react";

export interface DropdownButtonItem {
  label: string;
  onClick: () => void;
}

export interface DropdownButtonProps {
  label: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  items: DropdownButtonItem[];
}

export default function DropdownButton(props: DropdownButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (
      containerRef.current &&
      !containerRef.current.contains(e.target as Node)
    ) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, handleClickOutside]);

  const disabledStyle: React.CSSProperties = props.disabled
    ? { opacity: 0.5, cursor: "not-allowed" }
    : {};

  return (
    <div
      ref={containerRef}
      style={{ display: "inline-flex", position: "relative" }}
    >
      <button
        className={props.className}
        onClick={props.onClick}
        disabled={props.disabled}
        style={{
          ...disabledStyle,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          borderRight: "none",
        }}
      >
        {props.label}
      </button>
      <button
        className={props.className}
        disabled={props.disabled}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          ...disabledStyle,
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          paddingLeft: "0.2rem",
          paddingRight: "0.2rem",
        }}
      >
        ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: "2px",
            backgroundColor: "var(--color-panel)",
            border: "1px solid var(--color-border-light)",
            borderRadius: "0.3rem",
            zIndex: 100,
            minWidth: "100%",
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {props.items.map((item, i) => (
            <button
              key={i}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "0.4rem 0.6rem",
                fontSize: "0.8em",
                color: "var(--color-text-secondary)",
                backgroundColor: "transparent",
                border: "none",
                borderRadius: 0,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                  "#404040";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                  "transparent";
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
