import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
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

interface NavItem {
  label: string;
  icon: IconDefinition;
  /** Per-feature accent color, kept from the original design for identity. */
  color: string;
  rotate?: boolean;
}

const items: NavItem[] = [
  { label: "Files", icon: faFolder, color: "var(--color-files)" },
  {
    label: "Pending",
    icon: faPlay,
    color: "var(--color-pending)",
    rotate: true,
  },
  { label: "History", icon: faClock, color: "var(--color-history)" },
  { label: "Branches", icon: faCodeBranch, color: "var(--color-branches)" },
  { label: "Labels", icon: faTag, color: "var(--color-labels)" },
];

export default function WorkspaceMenu(
  props: WorkspaceMenuProps,
): React.ReactElement {
  return (
    <nav className="flex min-h-0 w-full flex-1 flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] py-2">
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2">
        {items.map((item, index) => {
          const active = props.activeIndex === index;
          return (
            <button
              key={item.label}
              type="button"
              title={item.label}
              onClick={() => props.setActiveIndex(index)}
              className={`flex h-9 items-center rounded-md border-0 bg-transparent text-sm transition-colors ${
                props.expanded ? "gap-3 px-3" : "justify-center px-0"
              } ${
                active
                  ? "bg-[var(--color-bg-overlay)] font-medium text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              <FontAwesomeIcon
                icon={item.icon}
                className="w-4 shrink-0 text-center"
                style={{
                  color: item.color,
                  transform: item.rotate ? "rotate(-90deg)" : undefined,
                }}
              />
              {props.expanded && <span>{item.label}</span>}
            </button>
          );
        })}
      </div>
      <div className="px-2">
        <button
          type="button"
          onClick={() => props.setExpanded(!props.expanded)}
          title={props.expanded ? "Collapse sidebar" : "Expand sidebar"}
          className="flex w-full items-center justify-center rounded-md border-0 bg-transparent py-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
        >
          <FontAwesomeIcon
            icon={props.expanded ? faAnglesLeft : faAnglesRight}
          />
        </button>
      </div>
    </nav>
  );
}
