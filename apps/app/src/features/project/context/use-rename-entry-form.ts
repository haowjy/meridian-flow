/**
 * useRenameEntryForm — inline context entry renaming, built on useInlineEdit.
 *
 * Adds rename-specific behavior: the stored name pre-populated, selection of
 * the part before a visible extension (all of a prose name), sibling filtering
 * that excludes the current name, and same-name = cancel semantics. Names are
 * compared and submitted as the codec stores them, so `Chapter 13.md` on
 * `Chapter 13` is no change and `settings` on `config.toml` is `settings.toml`.
 */

import { t } from "@lingui/core/macro";
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  storedFilename,
} from "@meridian/contracts/protocol";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { TabOwner } from "@/client/stores";
import { type InlineEdit, useInlineEdit } from "@/components/ui/use-inline-edit";
import { useAccountResourceReplica } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import {
  entryNameKey,
  entryNameStemEnd,
  parentContextEntryPath,
  validateContextEntryName,
} from "./context-entry-name";
import { destinationOwner } from "./identity-location";

export type UseRenameEntryFormOptions = {
  projectId: string;
  entryId: string;
  /** Who holds the entry: a Work row, or a chat's lineage with its handle. */
  owner: TabOwner;
  scheme: ProjectContextTreeScheme;
  /** Current full path of the entry being renamed. */
  path: string;
  /** Stored name of the entry (pre-populates the input). */
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
  owner,
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
  const storedName = (typed: string) => {
    const stored = storedFilename(typed, currentName);
    return stored.ok ? stored.name : typed;
  };
  const mutation = useMutation({
    mutationFn: async (typed: string) => {
      const name = kind === "folder" ? typed : storedName(typed);
      const unavailable = () =>
        new Error(
          kind === "folder"
            ? t`This folder is unavailable. Refresh and try again.`
            : t`This file is unavailable. Refresh and try again.`,
        );
      const authority = destinationOwner(
        { scheme, ...(isWorkScopedProjectContextScheme(scheme) ? owner : {}) },
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
    () => siblingNames.filter((sibling) => entryNameKey(sibling) !== entryNameKey(currentName)),
    [siblingNames, currentName],
  );

  // Select the name sans a visible extension on focus ("outline" in
  // "outline.json"); a prose name has none, so all of it.
  const select = useCallback(
    (input: HTMLInputElement) => {
      const initialName = repairName ?? currentName;
      input.setSelectionRange(0, entryNameStemEnd(initialName, kind));
    },
    [currentName, repairName, kind],
  );

  return useInlineEdit({
    initial: repairName ?? currentName,
    unchanged: currentName,
    initialError: repairName
      ? t`That rename couldn't be completed. Choose another name or try again.`
      : undefined,
    validate: (draft) => validateContextEntryName(draft, filteredSiblings, kind, currentName),
    onCommit: async (typed) => {
      // Typing the name it already has, another way (`Chapter 13.md`), is no change.
      if (kind === "file" && storedName(typed) === currentName) return onDone();
      const operationId = await mutation.mutateAsync(typed);
      if (operationId) onRenamed?.(operationId);
      onDone();
    },
    onCancel: onDone,
    select,
    // A refused rename is retried by an explicit Enter, never by leaving the field.
    commitOnBlur: !repairName,
  });
}
