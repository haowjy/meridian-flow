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
  currentName: string;
  row?: NamedRow;
  kind: ContextCreateKind;
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
  const rename = (typed: string) => {
    const stored = kind === "file" ? storedDocumentName(typed, row) : null;
    if (stored && !stored.ok) throw new Error(stored.message);
    actions
      .holding(entryId)
      .list.rename(entryId, stored?.name ?? typed, stored?.filename.filetype ?? undefined);
  };

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
      if (kind === "file" && storedName(typed) === currentName) return onDone();
      rename(typed);
      onDone();
    },
    onCancel: onDone,
    select,
  });
}
