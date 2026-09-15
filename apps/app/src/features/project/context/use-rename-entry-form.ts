/**
 * useRenameEntryForm — inline context entry renaming, built on useInlineNameForm.
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAccountResourceReplica } from "./account-feature-context";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath } from "./context-entry-name";
import { createContextIdentityMutationService } from "./context-identity-mutation";
import { type InlineNameForm, useInlineNameForm } from "./use-inline-name-form";

export type UseRenameEntryFormOptions = {
  projectId: string;
  entryId: string;
  workId: string | null;
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
  /** Called when the form completes (successful rename or cancel). */
  onDone: () => void;
};

export type RenameEntryForm = InlineNameForm;

export function useRenameEntryForm({
  projectId,
  entryId,
  workId,
  scheme,
  path,
  currentName,
  repairName,
  siblingNames,
  kind,
  onDone,
}: UseRenameEntryFormOptions): RenameEntryForm {
  const queryClient = useQueryClient();
  const resources = useAccountResourceReplica();
  const ownedWorkId = isWorkScopedProjectContextScheme(scheme) ? workId : null;
  const mutation = useMutation({
    mutationFn: async (name: string) => {
      if (kind === "file" && !isWorkScopedProjectContextScheme(scheme)) {
        const key = await resources.keyForDocument(projectId, entryId);
        if (!key) throw new Error(t`This file is unavailable. Refresh and try again.`);
        await resources.setLocation(projectId, key, {
          scheme,
          folderPath: parentContextEntryPath(path),
          name,
          workId: ownedWorkId,
        });
        return;
      }
      const result = await createContextIdentityMutationService(queryClient).move(
        entryId,
        projectId,
        { scheme, path, ...(ownedWorkId ? { workId: ownedWorkId } : {}) },
        {
          name,
          destination: {
            scheme,
            folderPath: parentContextEntryPath(path),
            ...(ownedWorkId ? { workId: ownedWorkId } : {}),
          },
        },
        kind,
      );
      if (result.result.status === "conflict") throw new Error(t`That name is already in use.`);
      if (result.result.status === "retry") throw new Error(t`The location changed. Try again.`);
    },
  });

  // Exclude the current name from collision checks — renaming "foo" to "foo"
  // is a no-op, not a collision.
  const filteredSiblings = useMemo(
    () => siblingNames.filter((sibling) => sibling.replace(/\/$/, "") !== currentName),
    [siblingNames, currentName],
  );

  const handleSubmit = useCallback(
    async (trimmed: string) => {
      await mutation.mutateAsync(trimmed);
    },
    [mutation],
  );

  // Select the name sans extension on focus (e.g. "chapter-1" in "chapter-1.md").
  const afterFocus = useCallback(
    (input: HTMLInputElement) => {
      const initialName = repairName ?? currentName;
      const dotIndex = initialName.lastIndexOf(".");
      input.setSelectionRange(0, dotIndex > 0 ? dotIndex : initialName.length);
    },
    [currentName, repairName],
  );

  return useInlineNameForm({
    initialName: repairName ?? currentName,
    initialError: repairName
      ? t`That rename couldn't be completed. Choose another name or try again.`
      : undefined,
    siblingNames: filteredSiblings,
    kind,
    isPending: mutation.isPending,
    onSubmit: handleSubmit,
    onDone,
    isCancelName: (n) => n === currentName,
    afterFocus,
  });
}
