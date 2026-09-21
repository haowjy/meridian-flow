/**
 * useCreateEntryForm — inline context entry creation, built on useInlineNameForm.
 *
 * Adds create-specific metadata (dynamic file icon, kind-aware placeholder) and
 * the create mutation. Submit semantics are inherited from the shared core:
 * Enter commits, Escape cancels, blur-with-content commits.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  classifyFiletype,
  filetypeForPath,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { useCallback } from "react";

import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { useAccountResourceReplica } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import { joinContextEntryPath } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import { type InlineNameForm, useInlineNameForm } from "./use-inline-name-form";

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

export type CreateEntryForm = InlineNameForm & {
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

  const handleSubmit = useCallback(
    async (trimmed: string) => {
      const path = joinContextEntryPath(parent, trimmed);
      if (
        kind === "file" &&
        !isWorkScopedProjectContextScheme(scheme) &&
        usesResourceDocumentCreate(path)
      ) {
        const reservation = await resources.reserveDocument(projectId, parent);
        if (reservation.content.kind !== "opened") throw new Error(t`Couldn't create this file.`);
        try {
          await resources.setLocation(projectId, reservation.key, {
            scheme,
            folderPath: parent,
            name: trimmed,
            workId: null,
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
        // A created document is opened, so it belongs in recents. The editor-tab
        // seam cannot see it until the tab is projected from the catalog, so the
        // create path records the reservation's document id itself; the recorder
        // retries while the server-side row is still materializing.
        void recordRecentDocument(reservation.content.handle.documentId, resources.accountId).then(
          (recorded) => {
            if (recorded) {
              void queryClient.invalidateQueries({
                queryKey: accountQueryKeys.recentDocumentsRoot,
              });
            }
          },
        );
      } else {
        await mutation.mutateAsync({ scheme, type: kind, path, workId });
      }
      onCreated?.(path);
    },
    [mutation, queryClient, projectId, scheme, kind, parent, onCreated, resources, workId],
  );

  const form = useInlineNameForm({
    initialName: "",
    siblingNames,
    kind,
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
