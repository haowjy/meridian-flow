/**
 * useInlineNameForm — shared state machine for inline name input rows.
 *
 * Both useCreateEntryForm and useRenameEntryForm are thin adapters over this
 * core. It owns: name state, validation (sibling collision), server-error
 * state, inputRef with focus + rAF retry, keyboard/blur commit semantics,
 * and the submit-or-cancel flow.
 *
 * Submit semantics: Enter commits; Escape cancels; blur-with-content commits
 * (unless Escape already cancelled). Empty or cancel-name input = cancel.
 * Blocking errors keep the row open and refocus the input.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";

import { type ContextEntryNameSeverity, validateContextEntryName } from "./context-entry-name";

export type UseInlineNameFormOptions = {
  initialName: string;
  siblingNames: readonly string[];
  isPending: boolean;
  /** Perform the actual mutation. Throw on server error. */
  onSubmit: (trimmedName: string) => Promise<void>;
  /** Called when the form completes (successful submit or cancel). */
  onDone: () => void;
  /** Returns true if this name should cancel without mutation (e.g. same as current). */
  isCancelName?: (trimmedName: string) => boolean;
  /** Called after focus is established (initial + rAF retry), for custom selection. */
  afterFocus?: (input: HTMLInputElement) => void;
};

export type InlineNameForm = {
  name: string;
  inputRef: RefObject<HTMLInputElement | null>;
  severity: ContextEntryNameSeverity | null;
  isPending: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onBlur: () => void;
};

export function useInlineNameForm({
  initialName,
  siblingNames,
  isPending,
  onSubmit,
  onDone,
  isCancelName,
  afterFocus,
}: UseInlineNameFormOptions): InlineNameForm {
  const [name, setName] = useState(initialName);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  // Auto-focus on mount. The rAF retry handles Radix menu focus scope
  // teardown — the menu's closing animation holds the scope for one frame,
  // swallowing a same-tick focus(). Harmless when no menu preceded the row.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    afterFocus?.(input);
    const raf = requestAnimationFrame(() => {
      input.focus();
      afterFocus?.(input);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable on mount
  }, []);

  const severity: ContextEntryNameSeverity | null = serverError
    ? { level: "error", message: serverError }
    : validateContextEntryName(name, siblingNames);

  async function submit() {
    if (isPending) return;
    const trimmed = name.trim();
    if (!trimmed || isCancelName?.(trimmed)) {
      onDone();
      return;
    }
    const check = validateContextEntryName(name, siblingNames);
    if (check?.level === "error") {
      inputRef.current?.focus();
      return;
    }
    try {
      await onSubmit(trimmed);
      onDone();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    name,
    inputRef,
    severity,
    isPending,
    onChange(event) {
      setName(event.target.value);
      if (serverError) setServerError(null);
    },
    onKeyDown(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelledRef.current = true;
        onDone();
      }
    },
    onBlur() {
      if (cancelledRef.current) return;
      void submit();
    },
  };
}
