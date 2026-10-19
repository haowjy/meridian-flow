/**
 * The browser's half of attribution: the room's text and the server's payload, classified once per
 * frame. The kernel answers byline (who wrote a change) and members (which AI writes are in it); this
 * joins those answers to conversations. A write's `owner` is the conversation the writer knows (for a
 * subagent, the primary conversation that spawned it), so every membership consumer reads
 * `members` and none walks lineage itself.
 */
import { type Author, classifyChanges } from "@meridian/agent-edit/diff";
import type { DraftProvenancePart, DraftProvenanceResponse } from "@meridian/contracts/branches";
import * as Y from "yjs";
import type { ReviewFrame } from "./review-frame";
import type { ChangeAttribution, ChatRef, ReviewChange } from "./review-model";

type Thread = Extract<Author, { kind: "thread" }>;

/** The AI write identity shared by receipts and thread authors. */
const writeKey = (part: Pick<DraftProvenancePart, "threadId" | "turnId" | "toolCallId">) =>
  JSON.stringify([part.threadId, part.turnId, part.toolCallId ?? null]);

const snapshots = new WeakMap<object, Y.Snapshot>();
const resolvers = new WeakMap<readonly DraftProvenancePart[], (author: Thread) => ChatRef>();

/** How each byline author is drawn, looked up by identity. Built once per payload, not per change or render. */
function chatResolver(edits: readonly DraftProvenancePart[]) {
  const known = resolvers.get(edits);
  if (known) return known;
  const exact = new Map<string, ChatRef>();
  const byThread = new Map<string | null, ChatRef>();
  for (const edit of edits) {
    const { owner } = edit;
    if (!owner) continue;
    const chat: ChatRef = {
      chatId: owner.threadId,
      title: owner.title,
      reveal: owner.reveal,
    };
    // Parts are listed latest first, so the first write of a key is the one a byline links to.
    const key = writeKey(edit);
    if (!exact.has(key)) exact.set(key, chat);
    if (!byThread.has(edit.threadId)) byThread.set(edit.threadId, chat);
  }
  const resolve = (author: Thread): ChatRef =>
    exact.get(writeKey(author)) ??
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
  data: Pick<DraftProvenanceResponse, "userId" | "parts" | "snapshot" | "writers">,
  localDeletions?: Y.Snapshot["ds"],
): ReadonlyMap<
  string,
  ChangeAttribution & {
    unresolved: boolean;
    unresolvedItems: readonly (readonly [number, number, number])[];
  }
> {
  let snapshot = snapshots.get(data);
  if (!snapshot) {
    snapshot = Y.decodeSnapshot(Uint8Array.from(data.snapshot));
    snapshots.set(data, snapshot);
  }
  const classified = classifyChanges(doc, frame, {
    userId: data.userId,
    parts: data.parts,
    writers: data.writers,
    snapshot,
    localClientId: doc.clientID,
    localDeletions,
  });
  const resolve = chatResolver(data.parts);
  return new Map(
    [...classified].map(([id, c]) => [
      id,
      {
        byline: c.byline,
        unresolved: c.unresolved,
        unresolvedItems: c.unresolvedItems,
        chats: chatsOf(c.byline, resolve),
        members: [
          ...new Set(
            c.members.flatMap((i) => {
              const owner = data.parts[i].owner;
              return owner ? [owner.threadId] : [];
            }),
          ),
        ],
      },
    ]),
  );
}
