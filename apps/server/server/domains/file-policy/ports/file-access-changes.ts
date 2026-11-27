import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import { loroRoomName } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";

export type FileAccessChange =
  | { workId: WorkId; closed?: ClosedOwnerWhy }
  | { rootThreadId: string; closed?: ClosedOwnerWhy }
  | { projectId: string }
  | { documentId: string };

export function fileAccessChangeKey(change: FileAccessChange): string {
  if ("workId" in change) return ownerAccessKey({ workId: change.workId });
  if ("projectId" in change) return projectAccessKey(change.projectId);
  if ("documentId" in change) return documentAccessKey(change.documentId);
  return ownerAccessKey({ rootThreadId: change.rootThreadId });
}

export function ownerAccessKey(owner: { workId: string } | { rootThreadId: string }): string {
  return "workId" in owner ? `work:${owner.workId}` : `lineage:${owner.rootThreadId}`;
}

export function projectAccessKey(projectId: string): string {
  return loroRoomName({ kind: "tree", list: { kind: "project", projectId } });
}

export function documentAccessKey(documentId: string): string {
  return `document:${documentId}`;
}

export interface FileAccessChanges {
  /**
   * Inside a transaction, every instance hears it only once that commits;
   * a rolled-back change is never heard.
   */
  publish(change: FileAccessChange): Promise<void>;
  subscribe(listener: (change: FileAccessChange) => void): () => void;
}
