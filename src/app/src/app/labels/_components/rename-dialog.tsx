"use client";

import { useEffect, useRef, useState } from "react";

interface RenameDialogProps {
  label: { id: string; name: string };
  isPending: boolean;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export function RenameDialog({
  label,
  isPending,
  onConfirm,
  onCancel,
}: RenameDialogProps) {
  const [name, setName] = useState(label.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed && trimmed !== label.name) {
      onConfirm(trimmed);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-white/20 bg-[#1e1e2e] p-6 shadow-xl">
        <h3 className="mb-4 text-lg font-semibold text-white">Rename Label</h3>
        <p className="mb-4 text-sm text-gray-400">
          Enter a new name for the label &ldquo;{label.name}&rdquo;
        </p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mb-4 w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 focus:border-[hsl(280,100%,70%)] focus:ring-1 focus:ring-[hsl(280,100%,70%)] focus:outline-none"
            placeholder="Label name"
            autoFocus
          />
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="rounded-md px-4 py-2 text-sm text-gray-400 transition-colors hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !name.trim() || name.trim() === label.name}
              className="rounded-md bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[hsl(280,100%,60%)] disabled:opacity-50"
            >
              {isPending ? "Renaming..." : "Rename"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
