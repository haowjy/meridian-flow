/** Browser-computed groups shared by rows, editor focus, counts and commands. Attribution only overlays them. */
import type { Author, ReviewGroup, ReviewSpan } from "@meridian/agent-edit/diff";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { groupAnchor, type ReviewFrame } from "./review-frame";
import { type TreeLine, treeChange, treeLineOf } from "./tree-line";

export type ReviewFocus = { id: string; frame: ReviewFrame | null };
export type ChatRef = {
  chatId: string;
  title: string;
  subagentTitle?: string;
  reveal?: { threadId: string; turnId: string; toolCallId?: string; subagentThreadId?: string };
};
export type ChangeAttribution = {
  byline: Author[];
  chats: ChatRef[];
  members: string[];
};

export interface ReviewChange extends ChangeAttribution {
  id: string;
  /** Remote text arrivals only; local edits never pulse. */
  arrival?: number;
  kind: ReviewGroup["kind"];
  excerpt: ReviewGroup["excerpt"];
  anchor: number;
  spans: ReviewSpan[];
  frame: ReviewFrame | null;
  /** Unknown membership must not be read as a known-empty chat. B3c supplies the overlay. */
  attributed: boolean;
  /** The branch's move or delete of the document: a row of its own, with no text frame. */
  tree?: TreeLine;
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
    attributed: attribution.has(group.id),
    anchor: groupAnchor(group),
    spans: group.spans,
    frame,
  }));
}

/** Items with no text (pictures and empty creations) are still one review row. */
export function itemChange(
  item: Pick<ThreadDraftListItem, "itemKey" | "documentName">,
): ReviewChange {
  return {
    id: `item:${item.itemKey}`,
    kind: "change",
    excerpt: { removed: "", inserted: item.documentName ?? "" },
    byline: [],
    chats: [],
    members: [],
    attributed: false,
    anchor: 0,
    spans: [],
    frame: null,
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
  changes.find((change) => change.id === focus?.id && change.frame?.diff === focus.frame?.diff) ??
  null;

/**
 * Changes are named by id, in the frame the writer chose on. With a room open a command reads the
 * room when it runs and maps the ids to it (`readChosen`), never refusing because the room moved:
 * the draft's base follows Live about 2 s behind. Without a room, `frame` is the cut it sends. A
 * tree line is the item's move or delete: alone (`tree`), or with text groups (`groups.tree`).
 */
export type TextTarget =
  | { kind: "groups"; frame: ReviewFrame; groupIds: string[]; tree?: true }
  /**
   * Every change of the draft. `draftId` is the list's: with no room open, the server applies
   * that draft's changes as it holds them on receipt.
   */
  | { kind: "draft"; draftId?: string };
/** Some of a draft's changes, which a Discard writes back in the draft's room. */
export type GroupsTarget = Extract<TextTarget, { kind: "groups" }>;
export type ChangeTarget = TextTarget | { kind: "tree" };
export function targetOfChanges(changes: readonly ReviewChange[]): ChangeTarget {
  const text = changes.filter((change) => !change.tree);
  const tree = text.length < changes.length;
  const frame = text[0]?.frame;
  if (frame)
    return {
      kind: "groups",
      frame,
      groupIds: text.map((change) => change.id),
      ...(tree ? { tree: true as const } : {}),
    };
  return tree && text.length === 0 ? { kind: "tree" } : { kind: "draft" };
}
