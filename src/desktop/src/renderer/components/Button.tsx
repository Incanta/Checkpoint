import React from "react";

export interface Props {
  label: string | React.ReactElement;
  tooltip?: string;
  className?: string;
  onClick?: () => void;
}

export default function Button(props: Props) {
  return (
    <button
      className={props.className}
      onClick={props.onClick || (() => {})}
      title={props.tooltip || ""}
    >
      {props.label}
    </button>
  );
}
