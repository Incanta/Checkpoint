"use client";

import { useEffect, useRef, useState } from "react";

interface ChangeChangelistDialogProps {
  label: { id: string; name: string; number: number };
  isPending: boolean;
  onConfirm: (newNumber: number) => void;
  onCancel: () => void;
}

export function ChangeChangelistDialog({
  label,
  isPending,
  onConfirm,
  onCancel,
}: ChangeChangelistDialogProps) {
  const [numberStr, setNumberStr] = useState(String(label.number));
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

  const parsedNumber = parseInt(numberStr, 10);
  const isValid =
    !isNaN(parsedNumber) && parsedNumber >= 0 && parsedNumber !== label.number;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isValid) {
      onConfirm(parsedNumber);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-white/20 bg-[#1e1e2e] p-6 shadow-xl">
        <h3 className="mb-4 text-lg font-semibold text-white">
          Change Changelist
        </h3>
        <p className="mb-4 text-sm text-gray-400">
          Enter the new changelist number for the label &ldquo;{label.name}
          &rdquo; (currently #{label.number})
        </p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="number"
            value={numberStr}
            onChange={(e) => setNumberStr(e.target.value)}
            min={0}
            step={1}
            className="mb-4 w-full [appearance:textfield] rounded-md border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 focus:border-[hsl(280,100%,70%)] focus:ring-1 focus:ring-[hsl(280,100%,70%)] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            placeholder="Changelist number"
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
              disabled={isPending || !isValid}
              className="rounded-md bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[hsl(280,100%,60%)] disabled:opacity-50"
            >
              {isPending ? "Updating..." : "Update"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
