import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faChevronRight } from "@fortawesome/free-solid-svg-icons";

/** One entry in a context menu: an action, a submenu, or a separator. */
export interface MenuItem {
  label?: ReactNode;
  command?: () => void;
  /** A submenu. */
  items?: MenuItem[];
  disabled?: boolean;
  separator?: boolean;
  /** Shows a check mark; items in the same menu line up whether checked or not. */
  checked?: boolean;
  /** Destructive actions (delete, archive) render in the danger color. */
  danger?: boolean;
  /** Hides the item without the caller having to filter the array. */
  visible?: boolean;
  /** Inline style for the item row (e.g. a one-off color). */
  style?: CSSProperties;
}

export interface ContextMenuHandle {
  /** Opens the menu at the pointer. Calls `preventDefault` on the event. */
  show: (event: React.MouseEvent | MouseEvent) => void;
  hide: () => void;
}

const contentClass =
  "z-[100000] min-w-[200px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-overlay)] p-1.5 text-sm text-[var(--color-text-primary)] shadow-[0_10px_15px_-3px_rgb(0_0_0/0.3),0_4px_6px_-4px_rgb(0_0_0/0.3)] outline-none";

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--color-bg-surface)] data-[state=open]:bg-[var(--color-bg-surface)]";

function MenuItems({ items }: { items: MenuItem[] }): React.ReactElement {
  // Menus are often built conditionally, so drop separators that would
  // lead, trail, or double up once hidden items are gone.
  const shown = items
    .filter((item) => item.visible !== false)
    .filter(
      (item, i, all) =>
        !item.separator ||
        (i > 0 && i < all.length - 1 && !all[i - 1]!.separator),
    );
  while (shown[shown.length - 1]?.separator) shown.pop();
  const hasChecks = shown.some((item) => item.checked !== undefined);

  return (
    <>
      {shown.map((item, index) => {
        if (item.separator) {
          return (
            <Menu.Separator
              key={index}
              className="mx-0 my-1 h-px bg-[var(--color-border-default)]"
            />
          );
        }

        const check = hasChecks && (
          <span className="flex w-3.5 shrink-0 justify-center">
            {item.checked && (
              <FontAwesomeIcon icon={faCheck} className="text-[0.85em]" />
            )}
          </span>
        );
        const color = item.danger
          ? { color: "var(--color-danger)" }
          : undefined;

        if (item.items) {
          return (
            <Menu.Sub key={index}>
              <Menu.SubTrigger
                disabled={item.disabled}
                className={itemClass}
                style={{ ...color, ...item.style }}
              >
                {check}
                <span className="flex-1">{item.label}</span>
                <FontAwesomeIcon
                  icon={faChevronRight}
                  className="text-[0.7em] text-[var(--color-text-muted)]"
                />
              </Menu.SubTrigger>
              <Menu.Portal>
                <Menu.SubContent
                  className={contentClass}
                  sideOffset={4}
                  alignOffset={-6}
                  collisionPadding={8}
                >
                  <MenuItems items={item.items} />
                </Menu.SubContent>
              </Menu.Portal>
            </Menu.Sub>
          );
        }

        return (
          <Menu.Item
            key={index}
            disabled={item.disabled}
            onSelect={() => item.command?.()}
            className={itemClass}
            style={{ ...color, ...item.style }}
          >
            {check}
            <span className="flex-1">{item.label}</span>
          </Menu.Item>
        );
      })}
    </>
  );
}

/**
 * A right-click menu opened imperatively at the pointer:
 *
 *   const menuRef = useRef<ContextMenuHandle>(null);
 *   <ContextMenu ref={menuRef} model={items} />
 *   onContextMenu={(e) => { setItems(...); menuRef.current?.show(e); }}
 *
 * Built on Radix's dropdown menu (keyboard navigation, submenus, collision
 * handling), anchored to an invisible point where the pointer was.
 */
export const ContextMenu = forwardRef<ContextMenuHandle, { model: MenuItem[] }>(
  function ContextMenu({ model }, ref) {
    // A new key per show remounts the menu, so a second right-click while it
    // is open moves it rather than leaving it anchored at the old spot.
    const [anchor, setAnchor] = useState<{
      x: number;
      y: number;
      key: number;
    } | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);

    useImperativeHandle(ref, () => ({
      show(event) {
        event.preventDefault();
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        setAnchor((prev) => ({
          x: event.clientX,
          y: event.clientY,
          key: (prev?.key ?? 0) + 1,
        }));
      },
      hide() {
        setAnchor(null);
      },
    }));

    if (!anchor) return null;

    return (
      <Menu.Root
        key={anchor.key}
        open
        // Non-modal, so a right-click elsewhere reaches its row and reopens
        // the menu there instead of only closing this one.
        modal={false}
        onOpenChange={(open) => {
          if (!open) setAnchor(null);
        }}
      >
        <Menu.Trigger asChild>
          <span
            aria-hidden
            style={{
              position: "fixed",
              left: anchor.x,
              top: anchor.y,
              width: 0,
              height: 0,
              pointerEvents: "none",
            }}
          />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className={contentClass}
            side="bottom"
            align="start"
            sideOffset={2}
            collisionPadding={8}
            onCloseAutoFocus={(e) => {
              // Focus goes back to whatever had it (the table), not the
              // invisible anchor.
              e.preventDefault();
              returnFocusRef.current?.focus({ preventScroll: true });
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <MenuItems items={model} />
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    );
  },
);
