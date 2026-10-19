/** Browser-computed groups shared by rows, editor focus, counts and commands. Attribution only overlays them. */
import type { Author, ReviewGroup, ReviewSpan } from "@meridian/agent-edit/diff";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { groupAnchor, type ReviewFrame } from "./review-frame";

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

/** A frozen frame is the command seam, never operation IDs or a later runtime read. */
export type ChangeTarget =
  | { kind: "groups"; frame: ReviewFrame; groupIds: string[] }
  | { kind: "draft" };
export function targetOfChanges(changes: readonly ReviewChange[]): ChangeTarget {
  const frame = changes[0]?.frame;
  return frame
    ? { kind: "groups", frame, groupIds: changes.map((change) => change.id) }
    : { kind: "draft" };
}
