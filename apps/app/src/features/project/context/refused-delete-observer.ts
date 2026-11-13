import { projectFolderNeedsRepair, projectResourceNeedsRepair } from "@meridian/resource-replica";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { ownRemovals } from "./entry-drag/entry-failure";
import { currentView } from "./entry-drag/execute-move";
import type { RemovedNoticeStore } from "./removed-notice-store";

/**
 * Ends the writer's own-removal mark when the server refuses a delete the local replica had
 * admitted. It reads the account-wide projection, so the end never waits for a screen: the writer
 * may be on another project, or the home screen, when the refusal arrives. Each refused intent
 * names its own project; a personal folder has none of its own.
 */
export function observeRefusedDeletes(
  resources: AccountResourceReplica,
  notices: Pick<RemovedNoticeStore, "ownRemovalEnded">,
): () => void {
  /** Refused intents already reported: each one ends its marks once. */
  const reported = new Set<string>();
  return resources.observeProjection(
    "",
    ({ records, folders }) => {
      for (const record of records) {
        const projectId = record.intents.find(
          (intent) => intent.state === "needs-repair" && intent.desired.kind === "delete",
        )?.projectId;
        if (!projectId) continue;
        const repair = projectResourceNeedsRepair(projectId, record);
        const documentId = record.resource.identity?.documentId;
        if (repair?.kind !== "delete" || !documentId || reported.has(repair.intentId)) continue;
        reported.add(repair.intentId);
        notices.ownRemovalEnded(projectId, [documentId]);
      }
      for (const folder of folders) {
        const repair = projectFolderNeedsRepair(folder);
        if (repair?.kind !== "delete" || reported.has(repair.intentId)) continue;
        const projectId = folder.intents.find(
          (intent) => intent.intentId === repair.intentId,
        )?.projectId;
        if (!projectId) continue;
        reported.add(repair.intentId);
        void currentView({ resources, projectId }).then((view) =>
          notices.ownRemovalEnded(
            projectId,
            ownRemovals(view, { kind: "folder", id: folder.folderId }),
          ),
        );
      }
    },
    () => undefined,
  );
}
