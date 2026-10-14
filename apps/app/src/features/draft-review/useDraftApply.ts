/**
 * What Apply carries from the browser: a `Y.snapshot` of the draft room at the projection the writer saw,
 * and the wait until the server holds everything in it, so the server can rebuild exactly that view.
 *
 * A frame (the open editor's, or a listed row's room) carries its own snapshot; Apply sends that one.
 * An item nobody has open (a strip row's Apply draft) is read from its room inside the command:
 * the room is retained, synced, snapshotted, and released when the command ends.
 */
import type { QueryClient } from "@tanstack/react-query";
import * as Y from "yjs";
import type { PreparedApply } from "@/client/query/draft-command-executor";
import type { DraftRef } from "@/client/query/draft-command-record";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ReviewFrame } from "./review-frame";
import { reviewRuntimeOf, whenAcknowledged } from "./review-runtime";

export function encodeSnapshot(snapshot: Y.Snapshot): string {
  let binary = "";
  for (const byte of Y.encodeSnapshot(snapshot)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * An Apply prepared from the frame the writer clicked in: its snapshot, never one read at send time, and the
 * wait until the server holds every update the draft's room has (which includes every update the snapshot does).
 */
export function prepareFromFrame(
  draft: DraftRef,
  frame: ReviewFrame,
): () => Promise<PreparedApply> {
  return async () => {
    const runtime = reviewRuntimeOf(draft);
    if (!runtime) throw new Error("The draft's room is no longer open");
    return { snapshot: encodeSnapshot(frame.snapshot), synced: runtime.acknowledged };
  };
}

let readerSequence = 0;

/** Read an unopened draft's room for the length of one command: retained, synced, snapshotted, then released. */
export async function acquireItemSnapshot(
  registry: Pick<
    LiveDocumentSessionRegistry,
    "retainBranchRooms" | "releaseBranchRooms" | "getBranchRoom"
  >,
  queryClient: QueryClient,
  draft: DraftRef,
): Promise<PreparedApply> {
  const meta = await queryClient.fetchQuery({ ...draftMetaQueryOptions(draft), staleTime: 0 });
  // A branchless item has no text to snapshot; a closed one answers `gone` at the send.
  if (meta.kind !== "text") return { snapshot: null, synced: () => Promise.resolve() };
  const owner = `apply-reader:${++readerSequence}`;
  registry.retainBranchRooms(owner, [meta.roomName]);
  const release = () => registry.releaseBranchRooms(owner);
  try {
    const session = registry.getBranchRoom(meta.roomName);
    await session.whenSynced();
    return {
      snapshot: encodeSnapshot(Y.snapshot(session.document)),
      synced: () => whenAcknowledged(session),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
