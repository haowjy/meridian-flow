/**
 * The browser's half of attribution: the room's text and the server's payload, classified once per
 * frame. The kernel answers byline (who wrote a change) and members (which AI writes are in it); this
 * joins those answers to conversations. A write's `owner` is the conversation the writer knows (for a
 * subagent, the primary conversation that spawned it), so every membership consumer reads
 * `members` and none walks lineage itself.
 */
import { type Author, classifyChanges } from "@meridian/agent-edit/diff";
import type { DraftAttribution, DraftAttributionEdit } from "@meridian/contracts/drafts";
import type * as Y from "yjs";
import type { ReviewFrame } from "./review-frame";
import type { ChangeAttribution, ChatRef, ReviewChange } from "./review-model";

type Thread = Extract<Author, { kind: "thread" }>;

const writeKey = (threadId: string, turnId: string, toolCallId?: string) =>
  `${threadId}\u0000${turnId}\u0000${toolCallId ?? ""}`;

const resolvers = new WeakMap<readonly DraftAttributionEdit[], (author: Thread) => ChatRef>();

/** How each byline author is drawn, looked up by identity. Built once per payload, not per change or render. */
function chatResolver(edits: readonly DraftAttributionEdit[]) {
  const known = resolvers.get(edits);
  if (known) return known;
  const exact = new Map<string, ChatRef>();
  const byThread = new Map<string, ChatRef>();
  for (const edit of edits) {
    const { owner } = edit;
    const chat: ChatRef = {
      chatId: owner.threadId,
      title: owner.title,
      reveal: owner.reveal,
      ...(owner.threadId !== edit.threadId ? { subagentTitle: edit.title } : {}),
    };
    // Parts are listed latest first, so the first write of a key is the one a byline links to.
    const key = writeKey(edit.threadId, edit.turnId, edit.toolCallId);
    if (!exact.has(key)) exact.set(key, chat);
    if (!byThread.has(edit.threadId)) byThread.set(edit.threadId, chat);
  }
  const resolve = (author: Thread): ChatRef =>
    exact.get(writeKey(author.threadId, author.turnId, author.toolCallId)) ??
    byThread.get(author.threadId) ?? { chatId: author.threadId, title: "" };
  resolvers.set(edits, resolve);
  return resolve;
}

/** The conversations a byline links to, each once (a subagent's write links its spawn row). */
function chatsOf(byline: readonly Author[], resolve: (author: Thread) => ChatRef): ChatRef[] {
  const chats: ChatRef[] = [];
  for (const author of byline) {
    if (author.kind !== "thread") continue;
    const chat = resolve(author);
    if (
      !chats.some(
        (c) =>
          c.chatId === chat.chatId && c.reveal?.subagentThreadId === chat.reveal?.subagentThreadId,
      )
    )
      chats.push(chat);
  }
  return chats;
}

/** Whether the writer (the project's one user) made some of the change; drawn as "You". */
export const writerIn = (change: Pick<ReviewChange, "byline">) =>
  change.byline.some((author) => author.kind === "user");

/** Per change id: its byline and the conversations it belongs to. Empty until the payload has loaded. */
export function classifyRoom(
  doc: Y.Doc,
  frame: ReviewFrame,
  data: Pick<DraftAttribution, "userId" | "edits">,
): ReadonlyMap<string, ChangeAttribution> {
  const classified = classifyChanges(doc, frame, {
    userId: data.userId,
    parts: data.edits,
  });
  const resolve = chatResolver(data.edits);
  return new Map(
    [...classified].map(([id, c]) => [
      id,
      {
        byline: c.byline,
        chats: chatsOf(c.byline, resolve),
        members: [...new Set(c.members.map((i) => data.edits[i].owner.threadId))],
      },
    ]),
  );
}
