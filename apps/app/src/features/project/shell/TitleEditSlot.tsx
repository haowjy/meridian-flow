/**
 * A title renamed in place, optimistically. Committing closes the field at
 * once and the new title shows from the rename's own cache update; a refused
 * rename reopens the field with the writer's text and the failure under it.
 * Callers own the resting trigger and the failure's positioned ancestor: the
 * failure is placed against the nearest `relative` element, so the owning
 * header can give it room beyond the title itself.
 */
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TabTitleField } from "./TabTitleField";

export function TitleEditSlot({
  label,
  failure,
  rename,
  maxLength,
  fieldClassName,
  failureClassName = "left-0 w-max max-w-72",
  children,
}: {
  /** The field's accessible name. */
  label: string;
  /** Shown under the reopened field when the rename was refused. */
  failure: string;
  /** Rejects when the rename was refused. */
  rename: (title: string) => Promise<unknown>;
  maxLength?: number;
  /** The field's typography and inset, matching the resting title. */
  fieldClassName?: string;
  /** Where the failure sits under the field. */
  failureClassName?: string;
  /** The resting title: `start` opens the field on `initial`. */
  children: (edit: {
    start: (initial: string) => void;
    triggerRef: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
}) {
  // `unchanged` stays the title the edit started from, so committing the
  // refused text again (Enter or blur on the reopened field) retries it.
  const [editing, setEditing] = useState<{ initial: string; unchanged: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const failureId = useId();
  const close = () => {
    setEditing(null);
    setFailed(false);
    // Back to the title, unless the writer already moved focus elsewhere.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    });
  };
  if (editing === null)
    return children({
      start: (initial) => setEditing({ initial, unchanged: initial }),
      triggerRef,
    });
  const { unchanged } = editing;
  return (
    <>
      <TabTitleField
        initial={editing.initial}
        unchanged={unchanged}
        label={label}
        maxLength={maxLength}
        className={fieldClassName}
        describedBy={failed ? failureId : undefined}
        onCommit={(next) => {
          close();
          rename(next).catch(() => {
            setFailed(true);
            setEditing({ initial: next, unchanged });
          });
        }}
        onCancel={close}
      />
      {failed ? (
        <p
          id={failureId}
          role="alert"
          className={cn(
            "absolute top-full z-20 mt-1 rounded-md border border-border bg-popover px-2 py-1.5 text-xs font-normal text-destructive shadow-sm",
            failureClassName,
          )}
        >
          {failure}
        </p>
      ) : null}
    </>
  );
}
