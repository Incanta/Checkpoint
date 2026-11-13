import {
  Children,
  Fragment,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

export interface SplitterPanelProps {
  /** Starting size, as a percentage of the splitter. */
  size?: number;
  /** Smallest size, as a percentage of the splitter. */
  minSize?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * One side of a `Splitter`. It only carries props; `Splitter` renders it as a
 * resizable panel.
 */
export function SplitterPanel(_props: SplitterPanelProps): ReactElement | null {
  return null;
}

export interface SplitterProps {
  /** "horizontal" puts the panels side by side, "vertical" stacks them. */
  layout?: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}

/**
 * Resizable panes with a draggable bar between each pair. Double-clicking a
 * bar returns the panes to their starting sizes.
 */
export function Splitter({
  layout = "horizontal",
  className = "",
  children,
}: SplitterProps): React.ReactElement {
  const panels = Children.toArray(children).filter(
    (child): child is ReactElement<SplitterPanelProps> =>
      isValidElement(child) && child.type === SplitterPanel,
  );
  const horizontal = layout === "horizontal";

  return (
    <Group orientation={layout} className={className}>
      {panels.map((panel, index) => {
        const { size, minSize, className: panelClass, style } = panel.props;
        return (
          <Fragment key={panel.key ?? index}>
            {index > 0 && (
              <Separator
                className={`group relative flex shrink-0 items-center justify-center bg-[var(--color-bg-secondary)] outline-none transition-colors delay-0 data-[separator=active]:bg-[var(--color-accent)] data-[separator=focus]:bg-[var(--color-accent)] data-[separator=hover]:bg-[var(--color-accent)] data-[separator=hover]:delay-500 ${
                  horizontal
                    ? "w-[calc(4px+0.4rem)] border-x border-y-0 border-solid border-[var(--color-border-default)]"
                    : "h-[calc(4px+0.4rem)] border-x-0 border-y border-solid border-[var(--color-border-default)]"
                }`}
              >
                <div
                  className={`rounded-lg bg-[var(--color-text-muted)] ${
                    horizontal ? "h-6 w-1" : "h-1 w-6"
                  }`}
                />
              </Separator>
            )}
            <Panel
              defaultSize={size !== undefined ? `${size}%` : undefined}
              minSize={minSize !== undefined ? `${minSize}%` : undefined}
              className={panelClass}
              style={style}
            >
              {panel.props.children}
            </Panel>
          </Fragment>
        );
      })}
    </Group>
  );
}
