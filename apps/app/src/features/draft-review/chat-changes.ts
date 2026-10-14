/**
 * The changes of one chat in a draft nobody has open, read for the length of one command: the room is
 * retained and synced, projected, matched against the attribution hint, and handed to Apply with its
 * snapshot. The strip's Apply runs it inside its command (`applyChatChanges`), which releases the room on
 * every path out, so it acts on this chat's changes and not the whole file.
 */
import { matchAttribution } from "@meridian/agent-edit/diff";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { QueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { ChatApplyPlan } from "@/client/query/draft-command-executor";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { projectRoom } from "./review-frame";
import { whenAcknowledged } from "./review-runtime";
import { encodeSnapshot } from "./useDraftApply";

let readerSequence = 0;

/** The room's changes the attribution hint names this chat for. */
export async function chatChangeTargets(
  queryClient: QueryClient,
  draft: { projectId: string; workId: string; documentId: string; itemKey: string },
  doc: Y.Doc,
  threadId: string,
) {
  const { edits } = await queryClient.fetchQuery({
    ...draftAttributionQueryOptions(draft),
    staleTime: 0,
  });
  const frame = projectRoom(doc);
  const hints = matchAttribution(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), frame, edits);
  const targets = frame.groups
    .filter((group) => hints.get(group.id)?.some((chat) => chat.threadId === threadId))
    .map((group) => ({ id: group.id, pin: frame.pins.get(group.id) as Y.RelativePosition }));
  return { frame, targets };
}

/** Null when the chat has no change in the draft (nothing to apply); otherwise `prepared.release` ends the room read. */
export async function acquireChatChanges(
  registry: Pick<
    LiveDocumentSessionRegistry,
    "retainBranchRooms" | "releaseBranchRooms" | "getBranchRoom"
  >,
  queryClient: QueryClient,
  draft: { projectId: string; workId: string; documentId: string; itemKey: string },
  threadId: string,
): Promise<ChatApplyPlan | null> {
  const meta = await queryClient.fetchQuery({ ...draftMetaQueryOptions(draft), staleTime: 0 });
  if (meta.kind !== "text") return null;
  const owner = `chat-changes:${++readerSequence}`;
  registry.retainBranchRooms(owner, [meta.roomName]);
  const release = () => registry.releaseBranchRooms(owner);
  try {
    const session = registry.getBranchRoom(meta.roomName);
    await session.whenSynced();
    const { frame, targets } = await chatChangeTargets(
      queryClient,
      draft,
      session.document,
      threadId,
    );
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
  } catch (error) {
    release();
    throw error;
  }
}
