/** The review's changes shared by rows, editor focus, counts and commands. Attribution only overlays them. */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { type TreeLine, treeChange, treeLineOf } from "./tree-line";

export type ReviewFocus = { id: string };
/** Who wrote a change: the writer, or a chat's turn. */
export type BylineEntry =
  | { kind: "user"; userId: string }
  | { kind: "thread"; threadId: string; turnId: string; toolCallId?: string };
export type ChatRef = {
  chatId: string;
  title: string;
  subagentTitle?: string;
  reveal?: { threadId: string; turnId: string; toolCallId?: string; subagentThreadId?: string };
};
export type ChangeAttribution = {
  byline: BylineEntry[];
  chats: ChatRef[];
  members: string[];
};

export interface ReviewChange extends ChangeAttribution {
  id: string;
  /** Remote text arrivals only; local edits never pulse. */
  arrival?: number;
  excerpt: { removed: string; inserted: string };
  /** Unknown membership must not be read as a known-empty chat. B3c supplies the overlay. */
  attributed: boolean;
  /** The branch's move or delete of the document: a row of its own, with no text frame. */
  tree?: TreeLine;
  /** The change is the item itself (a creation, a picture, a move or a delete), not some of its text. */
  whole?: true;
}

/** Items with no text (pictures and empty creations) are still one review row. */
export function itemChange(
  item: Pick<ThreadDraftListItem, "itemKey" | "documentName">,
): ReviewChange {
  return {
    id: `item:${item.itemKey}`,
    excerpt: { removed: "", inserted: item.documentName ?? "" },
    byline: [],
    chats: [],
    members: [],
    attributed: false,
    whole: true,
  };
}

/**
 * An item's rows: a whole item (a creation or picture) is one row; otherwise a move
 * comes first, then the text changes. Listed surfaces own the drafted-delete row.
 */
export function listedItemChanges(
  item: Pick<
    ThreadDraftListItem,
    "itemKey" | "documentName" | "wholeItem" | "isNew" | "tree" | "contextLocation"
  >,
  text: readonly ReviewChange[],
): readonly ReviewChange[] {
  const line = item.isNew ? null : treeLineOf(item);
  if (line) return [treeChange(item, line), ...text];
  return item.wholeItem ? [itemChange(item)] : text;
}

export function changeExcerpt(change: Pick<ReviewChange, "excerpt">) {
  return [
    ...(change.excerpt.removed ? [{ kind: "removed" as const, text: change.excerpt.removed }] : []),
    ...(change.excerpt.inserted ? [{ kind: "added" as const, text: change.excerpt.inserted }] : []),
  ];
}
export const changeTone = (change: Pick<ReviewChange, "excerpt">): "add" | "remove" =>
  change.excerpt.inserted ? "add" : "remove";

export const resolveFocusedChange = (changes: readonly ReviewChange[], focus: ReviewFocus | null) =>
  changes.find((change) => change.id === focus?.id) ?? null;

/**
 * What a press of a review row takes: the item's whole draft (`draft`), or only its tree line, the
 * item's move or delete (`tree`). One change in the text is the editor's (`useSuggestionChanges`).
 */
export type ChangeTarget = { kind: "draft" } | { kind: "tree" };
export function targetOfChanges(changes: readonly ReviewChange[]): ChangeTarget {
  return changes.length > 0 && changes.every((change) => change.tree)
    ? { kind: "tree" }
    : { kind: "draft" };
}
