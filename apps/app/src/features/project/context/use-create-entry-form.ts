/**
 * useCreateEntryForm — inline context entry creation, built on useInlineEdit.
 *
 * Adds create-specific metadata (dynamic file icon, kind-aware placeholder) and
 * the create record. Submit semantics are the shared inline-edit protocol:
 * Enter or blur commits, Escape or an empty name cancels.
 */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { classifyFiletype, storedFilename } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { useCallback } from "react";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import { joinContextEntryPath, validateContextEntryName } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import { useEntryActions } from "./entry-drag/entry-actions";

export type UseCreateEntryFormOptions = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  kind: ContextCreateKind;
  /** The folder the entry goes in, or the id of the tree's source at the top. */
  parentId: string;
  /** That folder's path; `""` at the top. */
  parent?: string;
  /** Sibling names for the clash warning. */
  siblings?: readonly ContextEntrySibling[];
  /** Called when the form completes (successful create or cancel). */
  onDone: () => void;
  /** Called on cancel instead of `onDone`. */
  onCancel?: () => void;
  /** Called after a successful create, with the new entry's path (numbered if a name was taken). */
  onCreated?: (path: string) => void;
};

export type CreateEntryForm = InlineEdit & {
  /** Icon for the current kind + name (updates dynamically by extension). */
  icon: LucideIcon;
  placeholder: string;
};

export function useCreateEntryForm({
  projectId,
  scheme,
  kind,
  parentId,
  parent = "",
  siblings = [],
  onDone,
  onCancel = onDone,
  onCreated,
}: UseCreateEntryFormOptions): CreateEntryForm {
  const actions = useEntryActions(projectId);

  // The entry is appended to the writer's copy of the list and shows at once; a refusal by the
  // server comes back on its row.
  const handleSubmit = useCallback(
    (typed: string) => {
      const unavailable = () =>
        new Error(
          kind === "folder" ? t`Couldn't create this folder.` : t`Couldn't create this file.`,
        );
      const stored = kind === "file" ? storedFilename(typed) : null;
      if (stored && !stored.ok) throw new Error(stored.message);
      const filetype = stored?.filename.filetype ?? "markdown";
      if (stored && classifyFiletype(filetype).kind !== "tracked") throw unavailable();
      const made = (scheme === "user" ? actions.account : actions.project).create({
        parentId,
        name: stored?.name ?? typed,
        ...(kind === "folder"
          ? { kind: "folder" as const }
          : { kind: "document" as const, filetype }),
      });
      if (!made.ok) throw unavailable();
      onCreated?.(joinContextEntryPath(parent, made.name));
    },
    [actions, scheme, kind, parentId, parent, onCreated],
  );

  const form = useInlineEdit({
    initial: "",
    validate: (draft) => validateContextEntryName(draft, siblings, kind),
    onCommit: (name) => {
      handleSubmit(name);
      onDone();
    },
    onCancel,
  });

  return {
    ...form,
    icon: kind === "folder" ? Folder : fileKindIcon(iconName(form.draft)),
    placeholder: kind === "folder" ? t`Folder name` : t`File name`,
  };
}

/** The icon previews the name the file will be stored under; an empty field is prose. */
function iconName(draft: string): string {
  const stored = storedFilename(draft);
  return stored.ok ? stored.name : draft;
}
