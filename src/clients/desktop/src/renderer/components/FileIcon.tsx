import React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLink } from "@fortawesome/free-solid-svg-icons/faLink";

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
  link = false,
}: {
  extension: string;
  /**
   * The row is a symbolic link or junction: badge the icon with a link mark,
   * the way a shortcut is drawn, so it does not pass for a plain file.
   */
  link?: boolean;
}) {
  if (extension === "none") {
    return <span />;
  }

  const ext =
    extension === " " ? "folder" : aliases[extension] || extension || "blank";

  const icon = (
    <>
      {overrides[ext] && (
        <img style={{ width: "0.9rem" }} src={overrides[ext]} alt={ext} />
      )}
      {!overrides[ext] && extension && (
        <span className={`fiv-sqo fiv-icon-blank fiv-icon-${ext}`}></span>
      )}
    </>
  );

  if (!link) return icon;

  return (
    <span className="relative inline-flex">
      {icon}
      <span
        className="absolute -bottom-0.5 -left-1 flex items-center justify-center rounded-sm text-[0.5rem] leading-none"
        style={{
          background: "var(--color-bg-primary)",
          color: "var(--color-text-primary)",
          padding: "1px",
        }}
      >
        <FontAwesomeIcon icon={faLink} />
      </span>
    </span>
  );
});
