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
  filetypeForPath,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { resourceWorkAuthorityFor } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { useCallback } from "react";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { useWorks } from "@/client/query/useWorks";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import { useAccountResourceReplica } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import { joinContextEntryPath, validateContextEntryName } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";

export type UseCreateEntryFormOptions = {
  projectId: string;
  workId: string | null;
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

export type CreateEntryForm = InlineEdit & {
  /** Icon for the current kind + name (updates dynamically by extension). */
  icon: LucideIcon;
  placeholder: string;
};

/** The durable local reservation protocol currently owns document-schema files only. */
export function usesResourceDocumentCreate(path: string): boolean {
  const classification = classifyFiletype(filetypeForPath(path));
  return classification.kind === "tracked" && classification.schemaType === "document";
}

export function useCreateEntryForm({
  projectId,
  workId,
  scheme,
  kind,
  parent = "",
  siblingNames = [],
  onDone,
  onCreated,
}: UseCreateEntryFormOptions): CreateEntryForm {
  const mutation = useCreateContextEntry(projectId);
  const queryClient = useQueryClient();
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);

  const handleSubmit = useCallback(
    async (trimmed: string) => {
      const path = joinContextEntryPath(parent, trimmed);
      if (kind === "file" && usesResourceDocumentCreate(path)) {
        const work = isWorkScopedProjectContextScheme(scheme)
          ? workId === noWork?.id
            ? noWork
            : works?.find((work) => work.id === workId)
          : null;
        if (isWorkScopedProjectContextScheme(scheme) && (!work || !noWork))
          throw new Error(t`Couldn't create this file.`);
        const reservation = await resources.reserveDocument(projectId, parent);
        if (reservation.content.kind !== "opened") throw new Error(t`Couldn't create this file.`);
        try {
          await resources.setLocation(projectId, reservation.key, {
            scheme,
            folderPath: parent,
            name: trimmed,
            ...(work && noWork
              ? resourceWorkAuthorityFor(work.id, { works: works ?? [], noWork })
              : { workId: null }),
          });
        } finally {
          reservation.content.handle.release();
        }
        // This path bypasses the create mutation's own invalidation, so the new
        // entry stays out of the cached catalog until we drop it here; without
        // this, the tree and any catalog-driven open lag behind the create.
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextCatalogView(
            projectId,
            scheme,
            isWorkScopedProjectContextScheme(scheme) ? workId : undefined,
          ),
        });
      } else {
        await mutation.mutateAsync({ scheme, type: kind, path, workId });
      }
      onCreated?.(path);
    },
    [
      mutation,
      queryClient,
      projectId,
      scheme,
      kind,
      parent,
      onCreated,
      resources,
      workId,
      works,
      noWork,
    ],
  );

  const form = useInlineEdit({
    initial: "",
    validate: (draft) => validateContextEntryName(draft, siblingNames, kind),
    onCommit: async (name) => {
      await handleSubmit(name);
      onDone();
    },
    onCancel: onDone,
  });

  return {
    ...form,
    icon: kind === "folder" ? Folder : fileKindIcon(form.draft || "untitled.md"),
    placeholder: kind === "folder" ? t`Folder name` : t`File name`,
  };
}
