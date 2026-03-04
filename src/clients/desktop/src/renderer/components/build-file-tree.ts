import type { FileTreeNode } from "./FileTreeItem";

/**
 * Build a nested file-tree from a flat list of file entries.
 * Each entry must have a `path` (slash-separated) and a `changeType`.
 */
export function buildFileTree<
  T extends { path: string; changeType: "ADD" | "DELETE" | "MODIFY" },
>(files: T[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const existingNode = currentLevel.find((n) => n.name === part);

      if (existingNode) {
        if (isLast) {
          existingNode.changeType = file.changeType;
        }
        currentLevel = existingNode.children;
      } else {
        const newNode: FileTreeNode = {
          name: part,
          path: isLast ? file.path : parts.slice(0, i + 1).join("/"),
          isDirectory: !isLast,
          changeType: isLast ? file.changeType : undefined,
          children: [],
          expanded: true,
        };
        currentLevel.push(newNode);
        currentLevel = newNode.children;
      }
    }
  }

  return root;
}

/**
 * Collect all directory paths from a tree (useful for auto-expanding).
 */
export function collectDirPaths(nodes: FileTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (node.isDirectory) {
        paths.add(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
}
