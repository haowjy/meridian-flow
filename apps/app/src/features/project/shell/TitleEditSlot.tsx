import {
  type ReactNode,
  type Ref,
  type RefObject,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { WorkClosedChip } from "@/components/app/WorkClosedChip";
import { cn } from "@/lib/utils";
import { TabTitleField } from "./TabTitleField";

/**
 * The latest rename committed per title, across every slot that edits it (a
 * Work's tab and heading are two slots over one name).
 */
const latestRename = new Map<string, number>();
let renames = 0;

export type TitleEditHandle = { start(initial: string): void };

export function TitleEditSlot({
  editRef,
  titleKey,
  label,
  failure,
  closed,
  rename,
  maxLength,
  fieldClassName,
  failureClassName = "left-0 w-max max-w-72",
  children,
}: {
  editRef?: Ref<TitleEditHandle>;
  titleKey: string;
  label: string;
  failure: (cause: unknown) => string;
  closed?: (cause: unknown) => string | null;
  rename: (title: string) => Promise<unknown>;
  maxLength?: number;
  fieldClassName?: string;
  failureClassName?: string;
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
  useImperativeHandle(
    editRef,
    () => ({ start: (initial) => setEditing({ initial, unchanged: initial, focus: true }) }),
    [],
  );
  const [refusal, setRefusal] = useState<{ line: string } | { closed: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const failureId = useId();
  const close = () => {
    setEditing(null);
    setRefusal(null);
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
              const sentence = closed?.(cause) ?? null;
              setRefusal(sentence === null ? { line: failure(cause) } : { closed: sentence });
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
      {refusal && "closed" in refusal ? (
        <WorkClosedChip id={failureId} sentence={refusal.closed} />
      ) : null}
      {refusal && "line" in refusal ? (
        <div
          className={cn(
            "absolute top-full z-20 mt-1 rounded-md border border-border bg-card font-normal shadow-float",
            failureClassName,
          )}
        >
          <InlineErrorRow id={failureId} message={refusal.line} />
        </div>
      ) : null}
    </>
  );
}

function focusIsIdle(triggerRef: RefObject<HTMLButtonElement | null>): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === triggerRef.current;
}
