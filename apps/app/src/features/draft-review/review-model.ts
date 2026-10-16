/**
 * The review as cards, rows, the stepper, the chip and counts read it: one `ReviewChange` per group of
 * the browser-computed projection. Pure. The projection decides what the changes are; attribution only
 * adds who wrote each change (the byline: authors, as identities) and which
 * conversations the change belongs to (`members`, which the dock and chat-scoped Apply and Discard read).
 */
import type { ReviewGroup, ReviewSpan } from "@meridian/agent-edit/diff";
import type { Author, DraftAttributionEdit } from "@meridian/contracts/drafts";
import * as Y from "yjs";
import { groupAnchor, type ReviewFrame } from "./review-frame";

/** A conversation a byline links to: how an `Author` of kind thread is shown. Made at render time. */
export interface ChatRef {
  /** The conversation the writer knows: for a subagent's write, the primary conversation that spawned it. */
  chatId: string;
  title: string;
  /** A subagent's own task title, for the link's accessible label and tooltip. */
  subagentTitle?: string;
  /** Where the latest write that made the change happened (a subagent's: its spawn row); absent for a list row. */
  reveal?: DraftAttributionEdit["owner"]["reveal"];
}

/** What the classifier says of one change, in the terms the surfaces read. */
export interface ChangeAttribution {
  /** Who wrote some of the change, as identities: the writer (user) and the threads whose writes made it. */
  byline: Author[];
  /** How each conversation in the byline is shown, each once, resolved when the payload was joined. */
  chats: ChatRef[];
  /** The conversations (`owner.threadId`) any of whose AI writes may be in the change: the dock's filter. */
  members: string[];
}

export interface ReviewChange {
  /** Runtime-local AI arrival sequence; absent for the initial read and writer edits. */
  arrival?: number;
  /** The group id: a content hash, stable while edits elsewhere change nothing inside the change. */
  id: string;
  kind: ReviewGroup["kind"];
  excerpt: ReviewGroup["excerpt"];
  /** Byline: who made some of the change, as identities. */
  byline: Author[];
  /** The conversations in the byline as they are drawn and linked; "You" is the byline's user author. */
  chats: ChatRef[];
  /** Membership: the conversations whose AI writes are in the change under any alignment. */
  members: string[];
  /** Draft position of the change's first mark in `frame`, where the stepper scrolls to. */
  anchor: number;
  spans: ReviewSpan[];
  /** Where the change's first mark was pinned in `frame`: with the hash, the change a click names. */
  pin: Y.RelativePosition;
  /**
   * The frame this change was listed from. Apply sends its snapshot and Discard finds `pin` again from it.
   * Null for a branchless item's change (`itemChange`): it has no text, so only item-level commands act on it.
   */
  frame: ReviewFrame | null;
}

export function reviewChanges(
  frame: ReviewFrame,
  attribution: ReadonlyMap<string, ChangeAttribution> = new Map(),
): ReviewChange[] {
  return frame.groups.map((group) => ({
    id: group.id,
    kind: group.kind,
    excerpt: group.excerpt,
    byline: attribution.get(group.id)?.byline ?? [],
    chats: attribution.get(group.id)?.chats ?? [],
    members: attribution.get(group.id)?.members ?? [],
    anchor: groupAnchor(group),
    spans: group.spans,
    pin: frame.pins.get(group.id) as Y.RelativePosition,
    frame,
  }));
}

export interface ExcerptRun {
  kind: "removed" | "added";
  text: string;
}

/** A change as one line: what it removed (struck) then what it wrote. */
export function changeExcerpt(change: Pick<ReviewChange, "excerpt">): ExcerptRun[] {
  const runs: ExcerptRun[] = [];
  if (change.excerpt.removed) runs.push({ kind: "removed", text: change.excerpt.removed });
  if (change.excerpt.inserted) runs.push({ kind: "added", text: change.excerpt.inserted });
  return runs;
}

/** Red and green only: a change that wrote text is green, one that only removed text is red. */
export function changeTone(change: Pick<ReviewChange, "excerpt">): "add" | "remove" {
  return change.excerpt.inserted ? "add" : "remove";
}

const NO_PLACE = Y.createRelativePositionFromTypeIndex(new Y.Doc().getText("item"), 0);

/**
 * The one change of a branchless item (a created image or an empty create): no text, so no frame and
 * no spans; it shows by its file name, and item Apply and item Discard settle it.
 */
export function itemChange(item: {
  itemKey: string;
  documentName: string | null;
  actorThreads: readonly { threadId: string; title: string | null }[];
}): ReviewChange {
  return {
    id: `item:${item.itemKey}`,
    kind: "change",
    excerpt: { removed: "", inserted: item.documentName ?? "" },
    byline: item.actorThreads.map((chat) => ({
      kind: "thread" as const,
      threadId: chat.threadId,
      turnId: "",
    })),
    chats: item.actorThreads.map((chat) => ({
      chatId: chat.threadId,
      title: chat.title?.trim() ?? "",
    })),
    members: item.actorThreads.map((chat) => chat.threadId),
    anchor: 0,
    spans: [],
    pin: NO_PLACE,
    frame: null,
  };
}
