export function FileIcon({ extension }: { extension: string }) {
  const overrides: any = {
    blend: "/blender.svg",
    uproject: "/unreal.svg",
    umap: "/unreal.svg",
    uasset: "/unreal.svg",
  };

  const aliases: Record<string, string> = {
    chkignore: "gitignore",
    chkhidden: "gitignore",
  };

  const ext =
    extension === " " ? "folder" : aliases[extension] || extension || "blank";

  return (
    <>
      {overrides[ext] && (
        <img style={{ width: "0.9rem" }} src={overrides[ext]} alt={ext} />
      )}
      {!overrides[ext] && extension && (
        <span className={`fiv-sqo fiv-icon-blank fiv-icon-${ext}`}></span>
      )}
    </>
  );
}
