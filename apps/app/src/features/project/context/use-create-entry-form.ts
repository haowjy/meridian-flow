/**
 * useCreateEntryForm — inline context entry creation, built on useInlineNameForm.
 *
 * Adds create-specific metadata (dynamic file icon, kind-aware placeholder) and
 * the create mutation. Submit semantics are inherited from the shared core:
 * Enter commits, Escape cancels, blur-with-content commits.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { useCallback } from "react";

import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";

import type { ContextCreateKind } from "./context-create-kind";
import { joinContextEntryPath } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import { type InlineNameForm, useInlineNameForm } from "./use-inline-name-form";

export type UseCreateEntryFormOptions = {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  kind: ContextCreateKind;
  /** Parent folder path. Defaults to `""` (scheme root). */
  parent?: string;
  /** Sibling names for collision detection. Omit to skip collision checks. */
  siblingNames?: readonly string[];
  /** Called when the form completes (successful create or cancel). */
  onDone: () => void;
  /** Called after a successful create, with the new entry's path. */
  onCreated?: (path: string) => void;
};

export type CreateEntryForm = InlineNameForm & {
  /** Icon for the current kind + name (updates dynamically by extension). */
  icon: LucideIcon;
  placeholder: string;
};

export function useCreateEntryForm({
  projectId,
  activeThreadId,
  scheme,
  kind,
  parent = "",
  siblingNames = [],
  onDone,
  onCreated,
}: UseCreateEntryFormOptions): CreateEntryForm {
  const mutation = useCreateContextEntry(projectId, { activeThreadId });

  const handleSubmit = useCallback(
    async (trimmed: string) => {
      const path = joinContextEntryPath(parent, trimmed);
      await mutation.mutateAsync({ scheme, type: kind, path });
      onCreated?.(path);
    },
    [mutation, scheme, kind, parent, onCreated],
  );

  const form = useInlineNameForm({
    initialName: "",
    siblingNames,
    isPending: mutation.isPending,
    onSubmit: handleSubmit,
    onDone,
  });

  return {
    ...form,
    icon: kind === "folder" ? Folder : fileKindIcon(form.name || "untitled.md"),
    placeholder: kind === "folder" ? t`Folder name` : t`File name`,
  };
}
