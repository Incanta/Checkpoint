import React, { useCallback } from "react";

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  changeType?: "ADD" | "DELETE" | "MODIFY";
  /** Which CLs this file was changed in */
  changelists?: number[];
  children: FileTreeNode[];
  expanded?: boolean;
}

export const changeTypeColors: Record<string, string> = {
  ADD: "#4CAF50",
  DELETE: "#F44336",
  MODIFY: "#2196F3",
};

export const changeTypeLabels: Record<string, string> = {
  ADD: "A",
  DELETE: "D",
  MODIFY: "M",
};

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
}

const itemBaseStyle: React.CSSProperties = {
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: "0.85rem",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const labelContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
  overflow: "hidden",
};

const dirIconStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#9CA3AF",
  width: "1rem",
  textAlign: "center",
};

const spacerStyle: React.CSSProperties = { width: "1rem" };

const nameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const badgeBaseStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: "bold",
  marginLeft: "0.5rem",
  flexShrink: 0,
};

const FileTreeItem = React.memo(function FileTreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  expandedPaths,
  onToggleExpand,
}: FileTreeItemProps) {
  const isSelected = node.path === selectedPath && !node.isDirectory;
  const isExpanded = expandedPaths.has(node.path);

  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      onToggleExpand(node.path);
    } else {
      onSelect(node.path);
    }
  }, [node.isDirectory, node.path, onSelect, onToggleExpand]);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelected) {
        e.currentTarget.style.backgroundColor = "#374151";
      }
    },
    [isSelected],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelected) {
        e.currentTarget.style.backgroundColor = "transparent";
      }
    },
    [isSelected],
  );

  return (
    <>
      <div
        onClick={handleClick}
        style={{
          ...itemBaseStyle,
          padding: "0.25rem 0.5rem",
          paddingLeft: `${depth + 0.5}rem`,
          backgroundColor: isSelected ? "#3A3A3A" : "transparent",
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span style={labelContainerStyle}>
          {node.isDirectory ? (
            <span style={dirIconStyle}>{isExpanded ? "▼" : "▶"}</span>
          ) : (
            <span style={spacerStyle} />
          )}
          <span style={nameStyle}>{node.name}</span>
        </span>
        {node.changeType && (
          <span
            style={{
              ...badgeBaseStyle,
              color:
                changeTypeColors[node.changeType] ||
                "var(--color-text-secondary)",
            }}
          >
            {changeTypeLabels[node.changeType]}
          </span>
        )}
      </div>
      {node.isDirectory &&
        isExpanded &&
        node.children.map((child) => (
          <FileTreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </>
  );
});

export default FileTreeItem;
