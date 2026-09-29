/**
 * A title renamed in place, optimistically. Committing closes the field at
 * once and the new title shows from the rename's own cache update; a refused
 * rename reopens the field with the writer's text and the failure under it.
 * Callers own the wrapper (it must be `relative`) and the resting trigger.
 */
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TabTitleField } from "./TabTitleField";

export function TitleEditSlot({
  label,
  failure,
  rename,
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
  const [editing, setEditing] = useState<string | null>(null);
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
  if (editing === null) return children({ start: setEditing, triggerRef });
  return (
    <>
      <TabTitleField
        initial={editing}
        label={label}
        className={fieldClassName}
        describedBy={failed ? failureId : undefined}
        onCommit={(next) => {
          close();
          rename(next).catch(() => {
            setFailed(true);
            setEditing(next);
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
