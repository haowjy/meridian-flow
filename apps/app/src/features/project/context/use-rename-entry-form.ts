/**
 * useRenameEntryForm — inline context entry renaming, built on useInlineEdit.
 *
 * Adds rename-specific behavior: pre-populated name, extension-aware selection
 * (selects basename without extension), sibling filtering that excludes the
 * current name, and same-name = cancel semantics.
 */

import { t } from "@lingui/core/macro";
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useWorks } from "@/client/query/useWorks";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import { useAccountResourceReplica } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath, validateContextEntryName } from "./context-entry-name";
import { destinationOwner } from "./identity-location";

export type UseRenameEntryFormOptions = {
  projectId: string;
  entryId: string;
  workId: string | null;
  /** A chat's Scratch: its lineage's first chat id and the handle its URI spells. */
  rootThreadId?: string;
  rootThreadRef?: string;
  scheme: ProjectContextTreeScheme;
  /** Current full path of the entry being renamed. */
  path: string;
  /** Current basename of the entry (pre-populates the input). */
  currentName: string;
  /** Failed durable destination restored after asynchronous namespace repair. */
  repairName?: string;
  /** Sibling names for collision detection (should include all siblings). */
  siblingNames: readonly string[];
  kind: ContextCreateKind;
  /** Called with the move's operation id once the rename is admitted, before `onDone`. */
  onRenamed?: (operationId: string) => void;
  /** Called when the form completes (successful rename or cancel). */
  onDone: () => void;
};

export type RenameEntryForm = InlineEdit;

export function useRenameEntryForm({
  projectId,
  entryId,
  workId,
  rootThreadId,
  rootThreadRef,
  scheme,
  path,
  currentName,
  repairName,
  siblingNames,
  kind,
  onRenamed,
  onDone,
}: UseRenameEntryFormOptions): RenameEntryForm {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  const ownedWorkId = isWorkScopedProjectContextScheme(scheme) ? workId : null;
  const mutation = useMutation({
    mutationFn: async (name: string) => {
      const unavailable = () =>
        new Error(
          kind === "folder"
            ? t`This folder is unavailable. Refresh and try again.`
            : t`This file is unavailable. Refresh and try again.`,
        );
      const authority = destinationOwner(
        {
          scheme,
          ...(ownedWorkId ? { workId: ownedWorkId } : {}),
          ...(rootThreadId ? { rootThreadId, rootThreadRef } : {}),
        },
        works,
        noWork,
      );
      if (!authority) throw unavailable();
      const destination = { scheme, folderPath: parentContextEntryPath(path), name, ...authority };
      if (kind === "folder") {
        return resources
          .setFolderLocation(projectId, entryId, destination)
          .catch(() => {
            throw unavailable();
          })
          .then(({ operationId }) => operationId);
      }
      const key = await resources.keyForDocument(projectId, entryId);
      if (!key) throw unavailable();
      return (await resources.setLocation(projectId, key, destination)).operationId;
    },
  });

  // Exclude the current name from collision checks — renaming "foo" to "foo"
  // is a no-op, not a collision.
  const filteredSiblings = useMemo(
    () => siblingNames.filter((sibling) => sibling.replace(/\/$/, "") !== currentName),
    [siblingNames, currentName],
  );

  // Select the name sans extension on focus (e.g. "chapter-1" in "chapter-1.md").
  const select = useCallback(
    (input: HTMLInputElement) => {
      const initialName = repairName ?? currentName;
      const dotIndex = initialName.lastIndexOf(".");
      input.setSelectionRange(0, dotIndex > 0 ? dotIndex : initialName.length);
    },
    [currentName, repairName],
  );

  return useInlineEdit({
    initial: repairName ?? currentName,
    unchanged: currentName,
    initialError: repairName
      ? t`That rename couldn't be completed. Choose another name or try again.`
      : undefined,
    validate: (draft) => validateContextEntryName(draft, filteredSiblings, kind),
    onCommit: async (name) => {
      const operationId = await mutation.mutateAsync(name);
      if (operationId) onRenamed?.(operationId);
      onDone();
    },
    onCancel: onDone,
    select,
    // A refused rename is retried by an explicit Enter, never by leaving the field.
    commitOnBlur: !repairName,
  });
}
