import React from "react";

// Public assets must go through BASE_URL. The packaged app loads index.html
// over file://, where a leading "/" resolves to the drive root instead of the
// app directory. Vite rewrites such paths in index.html but not in JS strings.
const asset = (file: string) => `${import.meta.env.BASE_URL}${file}`;

const overrides: Record<string, string> = {
  blend: asset("blender.svg"),
  uproject: asset("unreal.svg"),
  umap: asset("unreal.svg"),
  uasset: asset("unreal.svg"),
};

const aliases: Record<string, string> = {
  chkignore: "gitignore",
  chkhidden: "gitignore",
};

export const FileIcon = React.memo(function FileIcon({
  extension,
}: {
  extension: string;
}) {
  if (extension === "none") {
    return <span />;
  }

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
});
