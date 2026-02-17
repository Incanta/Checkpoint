import React from "react";

export interface Props {
  label: string | React.ReactElement;
  tooltip?: string;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export default function Button(props: Props) {
  return (
    <button
      className={props.className}
      onClick={props.onClick || (() => {})}
      title={props.tooltip || ""}
      disabled={props.disabled}
      style={
        props.disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined
      }
    >
      {props.label}
    </button>
  );
}
