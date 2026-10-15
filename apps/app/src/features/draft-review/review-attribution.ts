/**
 * The browser's half of attribution: the room's text and the server's payload, classified once per
 * frame. The kernel answers byline (who wrote a change) and members (which AI writes are in it); this
 * joins those answers to conversations. A write's `owner` is the conversation the writer knows (for a
 * subagent, the primary conversation that spawned it), so every membership consumer reads
 * `members` and none walks lineage itself.
 */
import {
  type Author,
  type ChangeClassification,
  classifyChanges,
  restorationLinks,
} from "@meridian/agent-edit/diff";
import type { DraftAttribution, DraftAttributionEdit } from "@meridian/contracts/drafts";
import type * as Y from "yjs";
import type { ReviewFrame } from "./review-frame";
import type { ChangeAttribution, ChatRef } from "./review-model";

type Thread = Extract<Author, { kind: "thread" }>;

function chatOf(edits: readonly DraftAttributionEdit[], author: Thread): ChatRef {
  const edit =
    edits.find(
      (e) =>
        e.threadId === author.threadId &&
        e.turnId === author.turnId &&
        e.toolCallId === author.toolCallId,
    ) ?? edits.find((e) => e.threadId === author.threadId);
  if (!edit) return { chatId: author.threadId, title: "" };
  const { owner } = edit;
  return {
    chatId: owner.threadId,
    title: owner.title,
    reveal: owner.reveal,
    ...(owner.threadId !== edit.threadId ? { subagentTitle: edit.title } : {}),
  };
}

export function toChangeAttribution(
  classified: ChangeClassification,
  edits: readonly DraftAttributionEdit[],
): ChangeAttribution {
  const chats: ChatRef[] = [];
  for (const author of classified.byline) {
    if (author.kind !== "thread") continue;
    const chat = chatOf(edits, author);
    const same = (c: ChatRef) =>
      c.chatId === chat.chatId && c.reveal?.subagentThreadId === chat.reveal?.subagentThreadId;
    if (!chats.some(same)) chats.push(chat);
  }
  return {
    writer: classified.byline.some((author) => author.kind === "user"),
    chats,
    members: [...new Set(classified.members.map((i) => edits[i].owner.threadId))],
  };
}

/** Per change id: its byline and the conversations it belongs to. Empty until the payload has loaded. */
export function classifyRoom(
  doc: Y.Doc,
  frame: ReviewFrame,
  data: Pick<DraftAttribution, "userId" | "edits" | "restorations">,
): ReadonlyMap<string, ChangeAttribution> {
  const classified = classifyChanges(doc, frame, {
    userId: data.userId,
    parts: data.edits,
    // The server proves what tombstone text allows; the browser adds its own undo stacks' restorations.
    restorations: [...data.restorations, ...restorationLinks(doc)],
  });
  return new Map([...classified].map(([id, c]) => [id, toChangeAttribution(c, data.edits)]));
}
