import React from "react";
import { Menu } from "primereact/menu";
import { Badge } from "primereact/badge";
import { Avatar } from "primereact/avatar";
import { classNames } from "primereact/utils";
import { MenuItem } from "primereact/menuitem";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFolder } from "@fortawesome/free-solid-svg-icons/faFolder";
import { faPlay } from "@fortawesome/free-solid-svg-icons/faPlay";
import { faClock } from "@fortawesome/free-solid-svg-icons/faClock";
import { faAnglesLeft } from "@fortawesome/free-solid-svg-icons/faAnglesLeft";
import { faAnglesRight } from "@fortawesome/free-solid-svg-icons/faAnglesRight";
import { faCodeBranch } from "@fortawesome/free-solid-svg-icons/faCodeBranch";
import { faTag } from "@fortawesome/free-solid-svg-icons/faTag";

export interface WorkspaceMenuProps {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}

export default function WorkspaceMenu(props: WorkspaceMenuProps) {
  const itemRenderer = (item: MenuItem) => {
    return (
      <div
        className="p-menuitem-content workspace-menu-item"
        title={item.label || ""}
        style={{
          backgroundColor:
            props.activeIndex === item.data?.index
              ? "#ffffff11"
              : "transparent",
          color: "#fff !important",
        }}
      >
        <a className="flex align-items-center p-menuitem-link">
          <div className="m-[0.8rem]">
            {item.icon}
            {props.expanded && (
              <span
                className="mx-2 ml-[0.4rem]"
                style={{
                  color: "#ddd",
                  fontWeight: "normal",
                }}
              >
                {item.label}
              </span>
            )}
          </div>
        </a>
      </div>
    );
  };

  const items: MenuItem[] = [
    {
      label: "Files",
      icon: (
        <FontAwesomeIcon
          icon={faFolder}
          style={{
            color: "#FFCA3B",
          }}
        />
      ),
      template: itemRenderer,
      command: () => props.setActiveIndex(0),
      data: {
        index: 0,
      },
    },
    {
      label: "Pending",
      icon: (
        <FontAwesomeIcon
          icon={faPlay}
          style={{ transform: "rotate(-90deg)", color: "#D43935" }}
        />
      ),
      template: itemRenderer,
      command: () => props.setActiveIndex(1),
      data: {
        index: 1,
      },
    },
    {
      label: "History",
      icon: <FontAwesomeIcon icon={faClock} style={{ color: "#3DC3F5" }} />,
      template: itemRenderer,
      command: () => props.setActiveIndex(2),
      data: {
        index: 2,
      },
    },
    {
      label: "Branches",
      icon: (
        <FontAwesomeIcon icon={faCodeBranch} style={{ color: "#21bd43" }} />
      ),
      template: itemRenderer,
      command: () => props.setActiveIndex(3),
      data: {
        index: 3,
      },
    },
    {
      label: "Labels",
      icon: <FontAwesomeIcon icon={faTag} style={{ color: "#8b21bd" }} />,
      template: itemRenderer,
      command: () => props.setActiveIndex(4),
      data: {
        index: 4,
      },
    },
  ];

  return (
    <div
      className="w-full"
      style={{
        backgroundColor: "#2C2C2C",
        borderColor: "#1A1A1A",
        borderWidth: "0 1px 0 0",
        borderStyle: "solid",
        position: "relative",
      }}
    >
      <Menu model={items} className="w-full md:w-15rem" />
      <div
        className="workspace-menu-item"
        style={{
          color: "#fff !important",
          position: "absolute",
          bottom: 0,
          width: "100%",
          cursor: "pointer",
        }}
        onClick={() => props.setExpanded(!props.expanded)}
      >
        <div className="m-[0.5rem] text-center">
          <FontAwesomeIcon
            icon={props.expanded ? faAnglesLeft : faAnglesRight}
          />
        </div>
      </div>
    </div>
  );
}
