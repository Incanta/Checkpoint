import type { CSSProperties, ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";

export interface DialogProps {
  visible: boolean;
  /** Called on Escape, the close button, or (with `dismissableMask`) an outside click. */
  onHide: () => void;
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** Usually just a width, e.g. `{ width: "30rem" }`. */
  style?: CSSProperties;
  className?: string;
  /** Extra classes for the body (between header and footer). */
  contentClassName?: string;
  /**
   * Whether the user can close it (close button and Escape). Turn off while
   * something is in flight that the dialog has to see through.
   */
  closable?: boolean;
  /** Close when clicking outside the dialog. Off by default, so a stray click can't throw away what was typed. */
  dismissableMask?: boolean;
  /** Short description for screen readers, when the body doesn't make it obvious. */
  ariaDescription?: string;
}

/**
 * A modal dialog with the app's header, body, and footer layout. Radix
 * handles the focus trap, focus return, Escape, scroll lock, and portal.
 */
export function Dialog({
  visible,
  onHide,
  header,
  footer,
  children,
  style,
  className = "",
  contentClassName = "",
  closable = true,
  dismissableMask = false,
  ariaDescription,
}: DialogProps): React.ReactElement {
  return (
    <RadixDialog.Root
      open={visible}
      onOpenChange={(open) => {
        if (!open) onHide();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[1000] bg-black/50 backdrop-blur-[1px]" />
        <RadixDialog.Content
          style={{ width: "30rem", ...style }}
          className={`fixed left-1/2 top-1/2 z-[1001] box-border flex max-h-[90vh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] text-left shadow-xl outline-none ${className}`}
          onOpenAutoFocus={(e) => {
            // Start in the first field rather than on the close button.
            const field = (
              e.currentTarget as HTMLElement
            ).querySelector<HTMLElement>(
              "input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled])",
            );
            if (field) {
              e.preventDefault();
              field.focus();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (!closable) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!dismissableMask || !closable) e.preventDefault();
          }}
          {...(ariaDescription ? {} : { "aria-describedby": undefined })}
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border-default)] px-5 py-3.5">
            <RadixDialog.Title className="m-0 min-w-0 truncate text-base font-semibold text-[var(--color-text-primary)]">
              {header}
            </RadixDialog.Title>
            {closable && (
              <RadixDialog.Close
                aria-label="Close"
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]"
              >
                <FontAwesomeIcon icon={faXmark} />
              </RadixDialog.Close>
            )}
          </div>
          {ariaDescription && (
            <RadixDialog.Description className="sr-only">
              {ariaDescription}
            </RadixDialog.Description>
          )}
          <div
            className={`min-h-0 flex-1 overflow-auto px-5 py-4 text-[var(--color-text-secondary)] ${contentClassName}`}
          >
            {children}
          </div>
          {footer && (
            <div className="shrink-0 border-t border-[var(--color-border-default)] px-5 py-3.5">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
