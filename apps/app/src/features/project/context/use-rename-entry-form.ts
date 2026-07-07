/**
 * useRenameEntryForm — inline context entry renaming, built on useInlineNameForm.
 *
 * Adds rename-specific behavior: pre-populated name, extension-aware selection
 * (selects basename without extension), sibling filtering that excludes the
 * current name, and same-name = cancel semantics.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useMemo } from "react";

import { useRenameContextEntry } from "@/client/query/useRenameContextEntry";

import { type InlineNameForm, useInlineNameForm } from "./use-inline-name-form";

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

export type RenameEntryForm = InlineNameForm;

export function useRenameEntryForm({
  projectId,
  activeThreadId,
  scheme,
  path,
  currentName,
  siblingNames,
  onDone,
}: UseRenameEntryFormOptions): RenameEntryForm {
  const mutation = useRenameContextEntry(projectId, scheme, { activeThreadId });

  // Exclude the current name from collision checks — renaming "foo" to "foo"
  // is a no-op, not a collision.
  const filteredSiblings = useMemo(
    () => siblingNames.filter((sibling) => sibling.replace(/\/$/, "") !== currentName),
    [siblingNames, currentName],
  );

  const handleSubmit = useCallback(
    async (trimmed: string) => {
      await mutation.mutateAsync({ path, newName: trimmed });
    },
    [mutation, path],
  );

  // Select the name sans extension on focus (e.g. "chapter-1" in "chapter-1.md").
  const afterFocus = useCallback(
    (input: HTMLInputElement) => {
      const dotIndex = currentName.lastIndexOf(".");
      input.setSelectionRange(0, dotIndex > 0 ? dotIndex : currentName.length);
    },
    [currentName],
  );

  return useInlineNameForm({
    initialName: currentName,
    siblingNames: filteredSiblings,
    isPending: mutation.isPending,
    onSubmit: handleSubmit,
    onDone,
    isCancelName: (n) => n === currentName,
    afterFocus,
  });
}
