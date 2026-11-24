/**
 * Port: tells every server instance that some files' access changed, so live
 * rooms admitted at the old level reconnect at the new one (file-access §7).
 */
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import { loroRoomName } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";

/**
 * Archive, unarchive, delete or restore of a Work: its own files (drafts, scratch). Or a
 * lineage gaining or losing its last live chat: its drafts freeze and thaw. `closed` is set when
 * the change leaves the owner closed (archive, delete, last chat to Trash, or a restore of a Work
 * that is still archived) and names why; an unarchive, a restore to open, or a thaw leaves it out.
 */
export type FileAccessChange =
  | { workId: WorkId; closed?: ClosedOwnerWhy }
  | { rootThreadId: string; closed?: ClosedOwnerWhy }
  /** A project deleted: its tree list's connections end (a tree list's key is its room name). */
  | { projectId: string }
  /** A document moved to another source, so possibly another Work: its connections end. */
  | { documentId: string };

/** The key a room registers under for this change: its owner's (`ownerAccessKey`). */
export function fileAccessChangeKey(change: FileAccessChange): string {
  if ("workId" in change) return ownerAccessKey({ workId: change.workId });
  if ("projectId" in change) return projectAccessKey(change.projectId);
  if ("documentId" in change) return documentAccessKey(change.documentId);
  return ownerAccessKey({ rootThreadId: change.rootThreadId });
}

/** The key a room registers under for a Work's or a lineage's lifecycle changes. */
export function ownerAccessKey(owner: { workId: string } | { rootThreadId: string }): string {
  return "workId" in owner ? `work:${owner.workId}` : `lineage:${owner.rootThreadId}`;
}

/** A project's key: its tree list's room name, so a deleted project ends its tree and document sockets. */
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
  /** Hears changes on this instance; returns the unsubscribe. */
  subscribe(listener: (change: FileAccessChange) => void): () => void;
}
