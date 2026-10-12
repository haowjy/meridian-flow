/**
 * useCreateEntryForm — inline context entry creation, built on useInlineEdit.
 *
 * Adds create-specific metadata (dynamic file icon, kind-aware placeholder) and
 * the create mutation. Submit semantics are the shared inline-edit protocol:
 * Enter or blur commits, Escape or an empty name cancels.
 */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  parseDocumentFilename,
  storedFilename,
} from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { useCallback } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import { useAccountResourceReplica } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import {
  contextEntryConflictMessage,
  joinContextEntryPath,
  validateContextEntryName,
} from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";

export type UseCreateEntryFormOptions = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  kind: ContextCreateKind;
  /** Parent folder path. Defaults to `""` (scheme root). */
  parent?: string;
  /** Sibling names for collision detection. Omit to skip collision checks. */
  siblings?: readonly ContextEntrySibling[];
  /** Called when the form completes (successful create or cancel). */
  onDone: () => void;
  /** Called after a successful create, with the new entry's path. */
  onCreated?: (path: string) => void;
};

export type CreateEntryForm = InlineEdit & {
  /** Icon for the current kind + name (updates dynamically by extension). */
  icon: LucideIcon;
  placeholder: string;
};

/** The durable local reservation protocol currently owns document-schema files only. */
export function usesResourceDocumentCreate(name: string): boolean {
  const parsed = parseDocumentFilename(name);
  if (!parsed.ok) return false;
  const classification = classifyFiletype(parsed.value.filetype);
  return classification.kind === "tracked" && classification.schemaType === "document";
}

export function useCreateEntryForm({
  projectId,
  scheme,
  kind,
  parent = "",
  siblings = [],
  onDone,
  onCreated,
}: UseCreateEntryFormOptions): CreateEntryForm {
  const mutation = useCreateContextEntry(projectId);
  const queryClient = useQueryClient();
  const resources = useAccountResourceReplica();

  const handleSubmit = useCallback(
    async (typed: string) => {
      // Submit the name the server will store, so the optimistic entry and the
      // server's answer are the same path and nothing flips when it arrives.
      const stored = kind === "file" ? storedFilename(typed) : null;
      const name = stored?.ok ? stored.name : typed;
      const path = joinContextEntryPath(parent, name);
      if (kind === "file" && usesResourceDocumentCreate(name)) {
        const destinationParent = await resources.findParentAtLocation(projectId, {
          scheme,
          path: parent,
          name: "",
          workId: null,
        });
        if (!destinationParent) throw new Error(t`Couldn't create this file.`);
        const reservation = await resources.reserveDocument(projectId, parent);
        if (reservation.content.kind !== "opened") throw new Error(t`Couldn't create this file.`);
        try {
          await resources.setLocation(projectId, reservation.key, {
            parent: destinationParent,
            name,
          });
        } finally {
          reservation.content.handle.release();
        }
        // This path bypasses the create mutation's own invalidation, so the new
        // entry stays out of the cached catalog until we drop it here; without
        // this, the tree and any catalog-driven open lag behind the create.
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextCatalogView(projectId, scheme, undefined),
        });
      } else {
        const result = await mutation.mutateAsync({ scheme, type: kind, path, workId: null });
        if (result.status === "conflict") {
          throw new Error(
            result.occupantKind
              ? contextEntryConflictMessage(name, result.occupantKind)
              : (validateContextEntryName(name, siblings, kind)?.message ??
                  contextEntryConflictMessage(name)),
          );
        }
      }
      onCreated?.(path);
    },
    [mutation, queryClient, projectId, scheme, kind, parent, onCreated, resources, siblings],
  );

  const form = useInlineEdit({
    initial: "",
    validate: (draft) => validateContextEntryName(draft, siblings, kind),
    onCommit: async (name) => {
      await handleSubmit(name);
      onDone();
    },
    onCancel: onDone,
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
