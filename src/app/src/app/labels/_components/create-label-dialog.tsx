"use client";

import { useEffect, useRef, useState } from "react";

interface CreateLabelDialogProps {
  isPending: boolean;
  onConfirm: (name: string, changelistNumber: number) => void;
  onCancel: () => void;
}

export function CreateLabelDialog({
  isPending,
  onConfirm,
  onCancel,
}: CreateLabelDialogProps) {
  const [name, setName] = useState("");
  const [numberStr, setNumberStr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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

  const parsedNumber = parseInt(numberStr, 10);
  const isValid =
    name.trim().length > 0 && !isNaN(parsedNumber) && parsedNumber >= 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isValid) {
      onConfirm(name.trim(), parsedNumber);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-white/20 bg-[#1e1e2e] p-6 shadow-xl">
        <h3 className="mb-4 text-lg font-semibold text-white">Create Label</h3>
        <p className="mb-4 text-sm text-gray-400">
          Create a new label pointing to a changelist
        </p>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="mb-1 block text-sm text-gray-300">
              Label Name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 focus:border-[hsl(280,100%,70%)] focus:ring-1 focus:ring-[hsl(280,100%,70%)] focus:outline-none"
              placeholder="e.g. v1.0.0"
              autoFocus
            />
          </div>
          <div className="mb-4">
            <label className="mb-1 block text-sm text-gray-300">
              Changelist Number
            </label>
            <input
              type="number"
              value={numberStr}
              onChange={(e) => setNumberStr(e.target.value)}
              min={0}
              step={1}
              className="w-full [appearance:textfield] rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 focus:border-[hsl(280,100%,70%)] focus:ring-1 focus:ring-[hsl(280,100%,70%)] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              placeholder="Changelist number"
            />
          </div>
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
              disabled={isPending || !isValid}
              className="rounded-md bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[hsl(280,100%,60%)] disabled:opacity-50"
            >
              {isPending ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
