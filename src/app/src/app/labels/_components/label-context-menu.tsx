"use client";

import { useEffect, useRef } from "react";

interface LabelContextMenuProps {
  x: number;
  y: number;
  label: { id: string; name: string };
  onDelete: (label: LabelContextMenuProps["label"]) => void;
  onRename: (label: LabelContextMenuProps["label"]) => void;
  onChangeChangelist: (label: LabelContextMenuProps["label"]) => void;
  onClose: () => void;
}

export function LabelContextMenu({
  x,
  y,
  label,
  onDelete,
  onRename,
  onChangeChangelist,
  onClose,
}: LabelContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Adjust position if menu would overflow the viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (rect.right > viewportWidth) {
        menuRef.current.style.left = `${x - rect.width}px`;
      }
      if (rect.bottom > viewportHeight) {
        menuRef.current.style.top = `${y - rect.height}px`;
      }
    }
  }, [x, y]);

  const menuItems = [
    {
      label: "Rename",
      icon: (
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
      ),
      onClick: () => onRename(label),
    },
    {
      label: "Change Changelist",
      icon: (
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
          />
        </svg>
      ),
      onClick: () => onChangeChangelist(label),
    },
    { type: "separator" as const },
    {
      label: "Delete",
      icon: (
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      ),
      onClick: () => onDelete(label),
      danger: true,
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-lg border border-white/20 bg-[#1e1e2e] py-1 shadow-xl"
      style={{ left: x, top: y }}
    >
      {menuItems.map((item, index) => {
        if ("type" in item && item.type === "separator") {
          return (
            <div
              key={`sep-${index}`}
              className="my-1 border-t border-white/10"
            />
          );
        }

        const menuItem = item as {
          label: string;
          icon: React.ReactNode;
          onClick: () => void;
          danger?: boolean;
        };

        return (
          <button
            key={menuItem.label}
            onClick={menuItem.onClick}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
              menuItem.danger
                ? "text-red-400 hover:bg-red-500/20"
                : "text-gray-300 hover:bg-white/10"
            }`}
          >
            {menuItem.icon}
            {menuItem.label}
          </button>
        );
      })}
    </div>
  );
}
