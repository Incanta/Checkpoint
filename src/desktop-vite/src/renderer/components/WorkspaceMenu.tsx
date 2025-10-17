import React from "react";
import { Menu } from "primereact/menu";
import { Badge } from "primereact/badge";
import { Avatar } from "primereact/avatar";
import { classNames } from "primereact/utils";
import { MenuItem } from "primereact/menuitem";

export default function TemplateDemo() {
  const itemRenderer = (item: MenuItem) => (
    <div className="p-menuitem-content">
      <a className="flex align-items-center p-menuitem-link">
        <span className={item.icon} />
        <span className="mx-2">{item.label}</span>
        {/* {item.badge && <Badge className="ml-auto" value={item.badge} />}
        {item.shortcut && (
          <span className="ml-auto border-1 surface-border border-round surface-100 text-xs p-1">
            {item.shortcut}
          </span>
        )} */}
      </a>
    </div>
  );

  const items: MenuItem[] = [
    {
      label: "Workspace Explorer",
      icon: "pi pi-folder",
      template: itemRenderer,
    },
    {
      label: "Pending Changes",
      icon: "pi pi-hourglass",
      template: itemRenderer,
    },
  ];

  return (
    <div className="card flex justify-content-center">
      <Menu model={items} className="w-full md:w-15rem" />
    </div>
  );
}
