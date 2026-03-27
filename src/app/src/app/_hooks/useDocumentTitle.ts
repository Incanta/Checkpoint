"use client";

import { useEffect } from "react";

/** Sets `document.title` reactively. Falls back to "Checkpoint VCS" when no title given. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ?? "Checkpoint VCS";
  }, [title]);
}
