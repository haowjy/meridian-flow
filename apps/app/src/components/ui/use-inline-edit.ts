import type * as React from "react";
import { useEffect, useRef, useState } from "react";

export type InlineEditIssue = { level: "error" | "warning"; message: string };

export type UseInlineEditOptions = {
  initial: string;
  unchanged?: string;
  initialError?: string;
  validate?: (draft: string) => InlineEditIssue | null;
  onCommit: (value: string) => void | Promise<void>;
  onCancel: () => void;
  select?: (input: HTMLInputElement) => void;
  focusOnMount?: boolean;
  commitOnBlur?: boolean;
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
  commitOnBlur = true,
}: UseInlineEditOptions) {
  const [draft, setDraft] = useState(initial);
  const [failure, setFailure] = useState<string | null>(initialError ?? null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
      onBlur: () => (commitOnBlur ? void commit() : cancel()),
    },
  };
}
