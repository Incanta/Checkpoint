import { useEffect, useRef, useState } from "react";
import { ipc } from "../../pages/ipc";

// Cap the in-memory log so a long sync cannot grow the renderer without bound.
const MAX_LINES = 5000;

export default function LogPane(): React.ReactElement {
  const [collapsed, setCollapsed] = useState(true);
  // Ring buffer lives in a ref; `version` forces a re-render on append without
  // reallocating the array each time. Log lines are never synced to atoms.
  const linesRef = useRef<string[]>([]);
  const [version, setVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return ipc.on("game-sync:log:append", (data) => {
      const buffer = linesRef.current;
      for (const line of data.lines) {
        buffer.push(line);
      }
      if (buffer.length > MAX_LINES) {
        buffer.splice(0, buffer.length - MAX_LINES);
      }
      setVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [version, collapsed]);

  const lineCount = linesRef.current.length;

  const handleClear = (): void => {
    linesRef.current = [];
    setVersion((v) => v + 1);
  };

  return (
    <div className="flex shrink-0 flex-col border-t border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-3 px-4 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="cursor-pointer border-0 bg-transparent text-xs font-medium uppercase tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {collapsed ? "▸" : "▾"} Log ({lineCount})
        </button>
        {!collapsed && lineCount > 0 && (
          <button
            type="button"
            onClick={handleClear}
            className="ml-auto cursor-pointer border-0 bg-transparent text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            Clear
          </button>
        )}
      </div>

      {!collapsed && (
        <div
          ref={scrollRef}
          className="h-48 overflow-auto border-t border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] px-4 py-2 font-mono text-xs leading-5 text-[var(--color-text-secondary)]"
        >
          {lineCount === 0 ? (
            <div className="text-[var(--color-text-muted)]">No output yet.</div>
          ) : (
            linesRef.current.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
