/**
 * useRenameEntryForm — shared state machine for inline context entry renaming.
 *
 * Parallel to useCreateEntryForm: owns name input state, validation (collision
 * check excluding the current name), the rename mutation, keyboard/blur commit
 * semantics, and autofocus with pre-selection. Used by both the desktop tree's
 * inline rename row and the mobile browser's inline rename row.
 *
 * Submit semantics: Enter commits; Escape cancels; blur-with-changed-content
 * commits (unless Escape already cancelled). Submitting the same name = cancel.
 * Blocking errors keep the row open and refocus the input.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";

import { useRenameContextEntry } from "@/client/query/useRenameContextEntry";

import { type ContextEntryNameSeverity, validateContextEntryName } from "./context-entry-name";

export type UseRenameEntryFormOptions = {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  /** Current full path of the entry being renamed. */
  path: string;
  /** Current basename of the entry (pre-populates the input). */
  currentName: string;
  /** Sibling names for collision detection (should include all siblings). */
  siblingNames: readonly string[];
  /** Called when the form completes (successful rename or cancel). */
  onDone: () => void;
};

export type RenameEntryForm = {
  name: string;
  inputRef: RefObject<HTMLInputElement | null>;
  severity: ContextEntryNameSeverity | null;
  isPending: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onBlur: () => void;
};

export function useRenameEntryForm({
  projectId,
  activeThreadId,
  scheme,
  path,
  currentName,
  siblingNames,
  onDone,
}: UseRenameEntryFormOptions): RenameEntryForm {
  const [name, setName] = useState(currentName);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);
  const mutation = useRenameContextEntry(projectId, scheme, { activeThreadId });

  // Auto-focus and select the name (without extension for files).
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select up to the last dot (the name sans extension), or all if no dot.
    const dotIndex = currentName.lastIndexOf(".");
    input.setSelectionRange(0, dotIndex > 0 ? dotIndex : currentName.length);
  }, [currentName]);

  // Exclude the current name from collision checks — renaming "foo" to "foo"
  // is a no-op, not a collision.
  const filteredSiblings = siblingNames.filter(
    (sibling) => sibling.replace(/\/$/, "") !== currentName,
  );

  const severity: ContextEntryNameSeverity | null = serverError
    ? { level: "error", message: serverError }
    : validateContextEntryName(name, filteredSiblings);

  async function submit() {
    if (mutation.isPending) return;
    const trimmed = name.trim();
    // Same name or empty = cancel.
    if (!trimmed || trimmed === currentName) {
      onDone();
      return;
    }
    const check = validateContextEntryName(name, filteredSiblings);
    if (check?.level === "error") {
      inputRef.current?.focus();
      return;
    }
    try {
      await mutation.mutateAsync({ path, newName: trimmed });
      onDone();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    name,
    inputRef,
    severity,
    isPending: mutation.isPending,
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
