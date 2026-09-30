/**
 * A title renamed in place, optimistically. Committing closes the field at
 * once and the new title shows from the rename's own cache update; a refused
 * rename reopens the field with the writer's text and the failure under it.
 * Only the latest rename can reopen it: a refusal a newer rename superseded
 * stays quiet, and one that lands while the writer is working elsewhere shows
 * without taking focus.
 * Callers own the resting trigger and the failure's positioned ancestor: the
 * failure is placed against the nearest `relative` element, so the owning
 * header can give it room beyond the title itself.
 */
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TabTitleField } from "./TabTitleField";

/**
 * The latest rename committed per title, across every slot that edits it (a
 * Work's tab and heading are two slots over one name).
 */
const latestRename = new Map<string, number>();
let renames = 0;

export function TitleEditSlot({
  titleKey,
  label,
  failure,
  rename,
  maxLength,
  fieldClassName,
  failureClassName = "left-0 w-max max-w-72",
  children,
}: {
  /** What is titled, e.g. `work:<id>`; a newer rename of it supersedes an older one. */
  titleKey: string;
  /** The field's accessible name. */
  label: string;
  /** Shown under the reopened field when the rename was refused, from its cause. */
  failure: (cause: unknown) => string;
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
  const [editing, setEditing] = useState<{
    initial: string;
    unchanged: string;
    focus: boolean;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const failureId = useId();
  const close = () => {
    setEditing(null);
    setRefusal(null);
    // Back to the title, unless the writer already moved focus elsewhere.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    });
  };
  if (editing === null)
    return children({
      start: (initial) => setEditing({ initial, unchanged: initial, focus: true }),
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
        describedBy={refusal ? failureId : undefined}
        invalid={refusal !== null}
        focusOnMount={editing.focus}
        onCommit={(next) => {
          const commit = ++renames;
          latestRename.set(titleKey, commit);
          close();
          rename(next)
            .catch((cause: unknown) => {
              if (latestRename.get(titleKey) !== commit) return;
              setRefusal(failure(cause));
              // An edit the writer already reopened keeps its draft.
              setEditing(
                (current) =>
                  current ?? { initial: next, unchanged, focus: focusIsIdle(triggerRef) },
              );
            })
            .finally(() => {
              if (latestRename.get(titleKey) === commit) latestRename.delete(titleKey);
            });
        }}
        onCancel={close}
      />
      {refusal ? (
        <p
          id={failureId}
          role="alert"
          className={cn(
            "absolute top-full z-20 mt-1 rounded-md border border-border bg-popover px-2 py-1.5 text-xs font-normal text-destructive shadow-sm",
            failureClassName,
          )}
        >
          {refusal}
        </p>
      ) : null}
    </>
  );
}

/** Focus rests on nothing, or on the title itself: the writer is not working elsewhere. */
function focusIsIdle(triggerRef: RefObject<HTMLButtonElement | null>): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === triggerRef.current;
}
