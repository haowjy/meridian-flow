/**
 * useCreateEntryForm — inline context entry creation, built on useInlineEdit.
 *
 * Adds create-specific metadata (dynamic file icon, kind-aware placeholder) and
 * the create record. Submit semantics are the shared inline-edit protocol:
 * Enter or blur commits, Escape or an empty name cancels.
 */

import { t } from "@lingui/core/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { classifyFiletype, documentFilenameAt } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { useCallback } from "react";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import { writeFirstAgentText } from "@/features/agents/agent-file-template";
import { useLiveDocumentSessionRegistry } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import {
  joinContextEntryPath,
  storedDocumentName,
  validateContextEntryName,
} from "./context-entry-name";
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
  /** Called when the form completes (successful create or cancel). */
  onDone: () => void;
  /** Called on cancel instead of `onDone`. */
  onCancel?: () => void;
  /** Called after a successful create, with the new entry's id. */
  onCreated?: (node: string) => void;
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
  onDone,
  onCancel = onDone,
  onCreated,
}: UseCreateEntryFormOptions): CreateEntryForm {
  const actions = useEntryActions(projectId);
  const registry = useLiveDocumentSessionRegistry();

  // The entry is appended to the writer's copy of the list and shows at once; a refusal by the
  // server comes back on its row.
  const handleSubmit = useCallback(
    (typed: string) => {
      const at = joinContextEntryPath(parent, typed.trim()).slice(1);
      const stored = kind === "file" ? storedNameAt(scheme, at, typed) : null;
      if (stored && !stored.ok) throw new Error(stored.message);
      const filetype = stored?.filetype ?? "markdown";
      if (stored && classifyFiletype(filetype).kind !== "tracked")
        throw new Error(t`This name can't be used. Try a different one.`);
      const made = (scheme === "user" ? actions.account : actions.project).create({
        parentId,
        name: stored?.name ?? typed,
        ...(kind === "folder"
          ? { kind: "folder" as const }
          : { kind: "document" as const, filetype }),
      });
      const path = joinContextEntryPath(parent, made.name);
      const location = kind === "file" ? agentsLocationOf(scheme, path.slice(1)) : null;
      if (location) void writeFirstAgentText(registry, projectId, made.node, location.path);
      onCreated?.(made.node);
    },
    [actions, registry, projectId, scheme, kind, parentId, parent, onCreated],
  );

  const form = useInlineEdit({
    initial: "",
    validate: (draft) => validateContextEntryName(draft, kind),
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

/**
 * The name and kind a file typed at `path` is stored with: in an Agents location, the literal
 * name as code text (Mars reads those bytes); anywhere else, the name codec's.
 */
function storedNameAt(
  scheme: ProjectContextTreeScheme,
  path: string,
  typed: string,
): { ok: true; name: string; filetype: string } | { ok: false; message: string } {
  if (agentsLocationOf(scheme, path)) {
    const parsed = documentFilenameAt(scheme, path);
    return parsed.ok
      ? { ok: true, name: typed.trim(), filetype: parsed.value.filetype }
      : { ok: false, message: parsed.error.message };
  }
  const stored = storedDocumentName(typed);
  return stored.ok
    ? { ok: true, name: stored.name, filetype: stored.filename.filetype ?? "markdown" }
    : { ok: false, message: stored.message };
}

/** The icon previews the name the file will be stored under; an empty field is prose. */
function iconName(draft: string): string {
  const stored = storedDocumentName(draft);
  return stored.ok ? stored.name : draft;
}
