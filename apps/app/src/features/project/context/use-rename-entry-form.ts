/**
 * useRenameEntryForm — inline context entry renaming, built on useInlineEdit.
 *
 * Adds rename-specific behavior: the stored name pre-populated, selection of
 * the part before a visible extension (all of a prose name), sibling filtering
 * that excludes the current identity, and same-name = cancel semantics. Names are
 * compared as the codec stores them, but submitted as typed, so `Chapter 13.md` on
 * `Chapter 13` is no change and `settings` on `config.toml` is `settings.toml`.
 */

import { t } from "@lingui/core/macro";
import { type NamedRow, storedFilename } from "@meridian/contracts/protocol";
import { useCallback, useMemo } from "react";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import {
  allocateContextEntryArrivalName,
  entryNameStemEnd,
  validateContextEntryName,
} from "./context-entry-name";
import { describeRenames } from "./entry-drag/drop-choice";
import { useEntryActions } from "./entry-drag/entry-actions";

export type UseRenameEntryFormOptions = {
  projectId: string;
  entryId: string;
  /** Stored name of the entry (pre-populates the input). */
  currentName: string;
  /** The renamed file's own naming facts; absent for a folder. */
  row?: NamedRow;
  /** The name the writer asked for, when the server refused the rename: offered again. */
  repairName?: string;
  /** Why the server refused it, in its words. */
  repairReason?: string;
  /** Sibling names for the clash warning (should include all siblings). */
  siblings: readonly ContextEntrySibling[];
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
  repairName,
  repairReason,
  siblings,
  kind,
  onDone,
}: UseRenameEntryFormOptions): RenameEntryForm {
  const actions = useEntryActions(projectId);
  const storedName = (typed: string) => {
    const stored = storedFilename(typed, row);
    return stored.ok ? stored.name : typed;
  };
  // The name is appended as a `rename` record and shows at once; the copy numbers a taken name.
  const rename = (typed: string) => {
    const stored = kind === "file" ? storedFilename(typed, row) : null;
    if (stored && !stored.ok) throw new Error(stored.message);
    const result = actions
      .holding(entryId)
      .list.rename(entryId, stored?.name ?? typed, stored?.filename.filetype ?? undefined);
    if (!result.ok)
      throw new Error(
        kind === "folder"
          ? t`This folder is unavailable. Refresh and try again.`
          : t`This file is unavailable. Refresh and try again.`,
      );
  };

  // Another entry may have a codec-equivalent name; only this identity is excluded.
  const filteredSiblings = useMemo(
    () => siblings.filter((sibling) => sibling.entryId !== entryId),
    [siblings, entryId],
  );

  const occupancy = useMemo(
    () => new Set(filteredSiblings.map((sibling) => sibling.name)),
    [filteredSiblings],
  );

  // Select the name sans a visible extension on focus ("outline" in
  // "outline.json"); a prose name has none, so all of it.
  const select = useCallback(
    (input: HTMLInputElement) => {
      const initialName = repairName ?? currentName;
      input.setSelectionRange(0, entryNameStemEnd(initialName, row));
    },
    [currentName, repairName, row],
  );

  return useInlineEdit({
    initial: repairName ?? currentName,
    unchanged: currentName,
    initialError: repairName
      ? (repairReason ?? t`That rename couldn't be completed. Choose another name or try again.`)
      : undefined,
    validate: (draft) => {
      const invalid = validateContextEntryName(draft, [], kind, row);
      if (invalid || !draft.trim()) return invalid;
      const as = allocateContextEntryArrivalName(draft, occupancy, kind, row);
      const name = allocateContextEntryArrivalName(draft, new Set<string>(), kind, row);
      const message = as === name ? null : describeRenames([{ name, as }]);
      return message ? { level: "warning", message } : null;
    },
    onCommit: (typed) => {
      // Typing the name it already has, another way (`Chapter 13.md`), is no change.
      if (kind === "file" && storedName(typed) === currentName) return onDone();
      rename(typed);
      onDone();
    },
    onCancel: onDone,
    select,
    // A refused rename is retried by an explicit Enter, never by leaving the field.
    commitOnBlur: !repairName,
  });
}
