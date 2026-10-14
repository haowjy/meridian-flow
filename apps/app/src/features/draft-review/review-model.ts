/**
 * The review as cards, rows, the stepper, the chip and counts read it: one `ReviewChange` per group of
 * the browser-computed projection. Pure. The projection decides what the changes are; attribution only
 * adds which chats' writes overlap a change (the attribution hint; nothing gates on it).
 */
import type { ChatHint, ReviewGroup, ReviewSpan } from "@meridian/agent-edit/diff";
import * as Y from "yjs";
import { groupAnchor, type ReviewFrame } from "./review-frame";

export interface ChatRef {
  chatId: string;
  title: string;
}

export interface ReviewChange {
  /** The group id: a content hash, stable while edits elsewhere change nothing inside the change. */
  id: string;
  kind: ReviewGroup["kind"];
  excerpt: ReviewGroup["excerpt"];
  chats: ChatRef[];
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
  attribution: ReadonlyMap<string, readonly ChatHint[]> = new Map(),
): ReviewChange[] {
  return frame.groups.map((group) => ({
    id: group.id,
    kind: group.kind,
    excerpt: group.excerpt,
    chats: (attribution.get(group.id) ?? []).map((chat) => ({
      chatId: chat.threadId,
      title: chat.title,
    })),
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
    chats: item.actorThreads.map((chat) => ({
      chatId: chat.threadId,
      title: chat.title?.trim() ?? "",
    })),
    anchor: 0,
    spans: [],
    pin: NO_PLACE,
    frame: null,
  };
}
