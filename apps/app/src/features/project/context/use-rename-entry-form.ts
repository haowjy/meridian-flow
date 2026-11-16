/**
 * useRenameEntryForm — inline context entry renaming, built on useInlineEdit.
 *
 * Adds rename-specific behavior: the stored name pre-populated, selection of
 * the part before a visible extension (all of a prose name), sibling filtering
 * that excludes the current identity, and same-name = cancel semantics. Names are
 * compared as the codec stores them, but submitted as typed, so `Chapter 13.md` on
 * `Chapter 13` is no change and `settings` on `config.toml` is `settings.toml`.
 */

import type { NamedRow } from "@meridian/contracts/protocol";
import { useCallback } from "react";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import type { ContextCreateKind } from "./context-create-kind";
import {
  entryNameStemEnd,
  storedDocumentName,
  validateContextEntryName,
} from "./context-entry-name";
import { useEntryActions } from "./entry-drag/entry-actions";

export type UseRenameEntryFormOptions = {
  projectId: string;
  entryId: string;
  /** Stored name of the entry (pre-populates the input). */
  currentName: string;
  /** The renamed file's own naming facts; absent for a folder. */
  row?: NamedRow;
  kind: ContextCreateKind;
  /** Called when the form completes (successful rename or cancel). */
  onDone: () => void;
};

export type RenameEntryForm = InlineEdit;

export function useRenameEntryForm({
  projectId,
  entryId,
  currentName,
  row,
  kind,
  onDone,
}: UseRenameEntryFormOptions): RenameEntryForm {
  const actions = useEntryActions(projectId);
  const storedName = (typed: string) => {
    const stored = storedDocumentName(typed, row);
    return stored.ok ? stored.name : typed;
  };
  // The name is appended as a `rename` record and shows at once; a sibling's name makes a twin.
  const rename = (typed: string) => {
    const stored = kind === "file" ? storedDocumentName(typed, row) : null;
    if (stored && !stored.ok) throw new Error(stored.message);
    actions
      .holding(entryId)
      .list.rename(entryId, stored?.name ?? typed, stored?.filename.filetype ?? undefined);
  };

  // Select the name sans a visible extension on focus ("outline" in
  // "outline.json"); a prose name has none, so all of it.
  const select = useCallback(
    (input: HTMLInputElement) => {
      input.setSelectionRange(0, entryNameStemEnd(currentName, row));
    },
    [currentName, row],
  );

  return useInlineEdit({
    initial: currentName,
    unchanged: currentName,
    validate: (draft) => validateContextEntryName(draft, kind, row),
    onCommit: (typed) => {
      // Typing the name it already has, another way (`Chapter 13.md`), is no change.
      if (kind === "file" && storedName(typed) === currentName) return onDone();
      rename(typed);
      onDone();
    },
    onCancel: onDone,
    select,
  });
}
