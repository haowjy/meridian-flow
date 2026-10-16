/**
 * The changes of one chat in a draft nobody has open, read for the length of one command: the room is
 * retained and synced, projected, classified against the attribution payload, and handed to Apply with its
 * snapshot. The draft dock's Apply runs it inside its command (`applyChatChanges`), which releases the room on
 * every path out, so it acts on this chat's changes and not the whole file.
 */
import type { QueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { ChatApplyPlan } from "@/client/query/draft-command-executor";
import { cachedForCommand, fetchForCommand } from "@/client/query/fetch-for-command";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import {
  type BranchRoomRegistry,
  readBranchRoom,
  withLiveRoom,
} from "@/core/editor/branch-room-read";
import { classifyRoom } from "./review-attribution";
import { projectRoom } from "./review-frame";
import { whenAcknowledged } from "./review-runtime";
import { encodeSnapshot } from "./useDraftApply";

/**
 * The room's changes that belong to this chat: those some of whose AI writes are the chat's (or a subagent's it
 * spawned). `read: "cached"` (a local Discard) classifies against the attribution already loaded, so an offline
 * Discard never waits for the network; a write the cached payload lacks reads as unresolved and is refused.
 */
export async function chatChangeTargets(
  queryClient: QueryClient,
  draft: { projectId: string; workId: string; documentId: string; itemKey: string },
  doc: Y.Doc,
  threadId: string,
  read: "fresh" | "cached" = "fresh",
) {
  const options = { ...draftAttributionQueryOptions(draft), staleTime: 0 };
  const attribution = await (read === "cached"
    ? cachedForCommand(queryClient, options)
    : fetchForCommand(queryClient, options));
  const frame = projectRoom(doc);
  const classified = classifyRoom(doc, frame, attribution);
  if ([...classified.values()].some((change) => change.unresolved))
    throw new Error("Changes are still loading. Try again.");
  const targets = frame.groups
    .filter((group) => classified.get(group.id)?.members.includes(threadId))
    .map((group) => ({ id: group.id, pin: frame.pins.get(group.id) as Y.RelativePosition }));
  return { frame, targets };
}

/** Null when the chat has no change in the draft (nothing to apply); otherwise `prepared.release` ends the room read. */
export async function acquireChatChanges(
  registry: BranchRoomRegistry,
  queryClient: QueryClient,
  draft: { projectId: string; workId: string; documentId: string; itemKey: string },
  threadId: string,
): Promise<ChatApplyPlan | null> {
  const meta = await fetchForCommand(queryClient, {
    ...draftMetaQueryOptions(draft),
    staleTime: 0,
  });
  if (meta.kind !== "text") return null;
  const read = readBranchRoom(registry, meta.roomName);
  const release = read.dispose;
  try {
    // The attribution fetch is an await: the room is checked again before its frame is read.
    return await withLiveRoom(read, async (session): Promise<ChatApplyPlan | null> => {
      const { frame, targets } = await chatChangeTargets(
        queryClient,
        draft,
        session.document,
        threadId,
      );
      read.assertLive(session);
      if (targets.length === 0) {
        release();
        return null;
      }
      return {
        targets,
        prepared: {
          snapshot: encodeSnapshot(frame.snapshot),
          synced: () => whenAcknowledged(session),
          release,
        },
      };
    });
  } catch (error) {
    release();
    throw error;
  }
}
