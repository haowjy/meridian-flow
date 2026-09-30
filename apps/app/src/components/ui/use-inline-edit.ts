/**
 * useInlineEdit — the one commit/cancel protocol for text edited in place.
 *
 * Pairs with `InlineEditInput`. Focuses and selects on mount (with a frame
 * retry, since a closing Radix menu holds focus for one frame), unless the
 * caller opens it without focus. Enter or blur
 * commits; Escape cancels; IME composition keys are ignored. An empty or
 * unchanged draft cancels instead of committing. A blocking validation issue
 * keeps the field open; a throw from `onCommit` keeps it open with the thrown
 * message. The caller closes the field from `onCommit` (on success) or
 * `onCancel`.
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";

export type InlineEditIssue = { level: "error" | "warning"; message: string };

export type UseInlineEditOptions = {
  initial: string;
  /** The draft that means "no change"; defaults to `initial`. */
  unchanged?: string;
  /** An error shown from the start, e.g. a failed earlier attempt. */
  initialError?: string;
  /** Live check of the draft; an `error` blocks commit. */
  validate?: (draft: string) => InlineEditIssue | null;
  /** Receives the trimmed, changed, valid draft. Throw to stay open. */
  onCommit: (value: string) => void | Promise<void>;
  onCancel: () => void;
  /** Selection once focused; defaults to selecting everything. */
  select?: (input: HTMLInputElement) => void;
  /** Take focus on mount; defaults to true. */
  focusOnMount?: boolean;
};

export type InlineEdit = ReturnType<typeof useInlineEdit>;

export function useInlineEdit({
  initial,
  unchanged = initial,
  initialError,
  validate,
  onCommit,
  onCancel,
  select = (input) => input.select(),
  focusOnMount = true,
}: UseInlineEditOptions) {
  const [draft, setDraft] = useState(initial);
  const [failure, setFailure] = useState<string | null>(initialError ?? null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set once the field has handed off (commit in flight, or cancel), so the
  // blur that follows Enter or Escape does not act a second time.
  const closed = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !focusOnMount) return;
    input.focus();
    select(input);
    const frame = requestAnimationFrame(() => {
      input.focus();
      select(input);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const issue: InlineEditIssue | null = failure
    ? { level: "error", message: failure }
    : (validate?.(draft) ?? null);

  const cancel = () => {
    if (closed.current) return;
    closed.current = true;
    onCancel();
  };

  const commit = async () => {
    if (closed.current) return;
    const value = draft.trim();
    if (!value || value === unchanged.trim()) return cancel();
    if (validate?.(draft)?.level === "error") {
      inputRef.current?.focus();
      return;
    }
    closed.current = true;
    setPending(true);
    try {
      await onCommit(value);
    } catch (error) {
      closed.current = false;
      setFailure(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setPending(false);
    }
  };

  return {
    draft,
    issue,
    pending,
    inputRef,
    inputProps: {
      ref: inputRef,
      value: draft,
      disabled: pending,
      "aria-invalid": issue?.level === "error" ? true : undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
        setFailure(null);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      },
      onBlur: () => void commit(),
    },
  };
}
