/** Deletes a tree entry through the replica; a failure to admit it toasts, a refusal lands on the row. */

import { t } from "@lingui/core/macro";
import { useCallback, useMemo } from "react";
import { getContextTabs } from "@/client/stores";
import { notifyFailure } from "@/components/app/failure-toast";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { useDockDocumentStore } from "../dock/dock-document-store";
import { useAccountResourceReplica, useOptionalRemovedNotices } from "./account-feature-context";
import type { DeleteTarget } from "./ContextEntryActions";
import { ENTRY_FAILURE_TOAST, type EntryRef } from "./entry-drag/entry";

/** The documents this delete takes off the writer's own tabs and dock, so no "removed" notice follows it. */
function ownDeletedDocumentIds(projectId: string, target: DeleteTarget): string[] {
  if (target.kind === "file") return [target.documentId];
  const folder = `${target.path.replace(/^\/+|\/+$/g, "")}/`;
  const dock = useDockDocumentStore.getState().occupant;
  const presented = [
    ...getContextTabs(projectId).tabs,
    ...(dock?.projectId === projectId ? [dock.tab] : []),
  ];
  return presented.flatMap((tab) =>
    tab.kind !== "new" &&
    tab.scheme === target.scheme &&
    (target.scheme !== "scratch" ||
      ((target.owner.workId == null || tab.workId === target.owner.workId) &&
        tab.rootThreadId === target.owner.rootThreadId)) &&
    tab.path.replace(/^\/+/, "").startsWith(folder)
      ? [tab.documentId]
      : [],
  );
}

export async function deleteEntry(
  resources: AccountResourceReplica,
  projectId: string,
  ref: EntryRef,
): Promise<void> {
  if (ref.kind === "folder") {
    await resources.deleteFolder(projectId, ref.id);
    return;
  }
  const key = await resources.keyForDocument(projectId, ref.id);
  if (!key) throw new Error("Document resource is unavailable");
  await resources.deleteDocument(projectId, key);
}

export function useDeleteContextEntry(projectId: string) {
  const resources = useAccountResourceReplica();
  const notices = useOptionalRemovedNotices();
  const requestDelete = useCallback(
    function run(target: DeleteTarget) {
      const settleMark =
        notices?.markOwnRemoval(projectId, ownDeletedDocumentIds(projectId, target)) ??
        (() => undefined);
      void (async () => {
        try {
          await deleteEntry(
            resources,
            projectId,
            target.kind === "file"
              ? { kind: "file", id: target.documentId }
              : { kind: "folder", id: target.entryId },
          );
          settleMark("removed");
        } catch {
          settleMark("kept");
          notifyFailure({
            key: ENTRY_FAILURE_TOAST,
            title: t`Couldn't delete ${target.name}.`,
            onRetry: () => run(target),
          });
        }
      })();
    },
    [notices, projectId, resources],
  );
  return useMemo(() => ({ requestDelete }), [requestDelete]);
}
