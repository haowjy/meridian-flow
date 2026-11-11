import { projectFolderNeedsRepair, projectResourceNeedsRepair } from "@meridian/resource-replica";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { ownRemovals } from "./entry-drag/entry-failure";
import type { RemovedNoticeStore } from "./removed-notice-store";

/**
 * Ends the writer's own-removal mark when the server refuses a delete the local replica had
 * admitted. It watches every project of the account, so the end never waits for a screen: the
 * writer may be on another project, or the home screen, when the refusal arrives.
 */
export function observeRefusedDeletes(
  resources: AccountResourceReplica,
  notices: Pick<RemovedNoticeStore, "ownRemovalEnded">,
): () => void {
  const projects = new Map<string, () => void>();
  /** Refused intents already reported: each one ends its marks once. */
  const reported = new Set<string>();
  const stopProjection = resources.onProjection((records) => {
    for (const record of records) {
      const projectId = record.intents[0]?.projectId;
      if (!projectId || projects.has(projectId)) continue;
      projects.set(
        projectId,
        resources.observeProjection(
          projectId,
          ({ records: projectRecords, folders }) => {
            for (const record of projectRecords) {
              const repair = projectResourceNeedsRepair(projectId, record);
              const documentId = record.resource.identity?.documentId;
              if (repair?.kind !== "delete" || !documentId || reported.has(repair.intentId))
                continue;
              reported.add(repair.intentId);
              notices.ownRemovalEnded(projectId, [documentId]);
            }
            for (const folder of folders) {
              const repair = projectFolderNeedsRepair(folder);
              if (
                repair?.kind !== "delete" ||
                (folder.projectId !== null && folder.projectId !== projectId) ||
                reported.has(repair.intentId)
              )
                continue;
              reported.add(repair.intentId);
              void ownRemovals(
                { resources, projectId },
                { kind: "folder", id: folder.folderId },
              ).then((documentIds) => notices.ownRemovalEnded(projectId, documentIds));
            }
          },
          () => undefined,
        ),
      );
    }
  });
  return () => {
    stopProjection();
    for (const stop of projects.values()) stop();
    projects.clear();
  };
}
