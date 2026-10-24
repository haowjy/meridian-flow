/**
 * A branch's pending move or delete of a document (its tree line), and the words for it: the
 * review row ("ch12: renaming to ch12-old") and the Work notice on the live document ("Ascension
 * is renaming this to ch12-old."). Live doesn't show either until Apply (D26). Works are named,
 * never by handle (#914).
 */
import { t } from "@lingui/core/macro";
import type { DocumentDraftHint, ThreadDraftListItem } from "@meridian/contracts/branches";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import { describeMove, type ParsedContextLocation } from "@/features/chat/document-display-name";
import type { ReviewChange } from "./review-model";

export type TreeLine =
  | { kind: "rename" | "move"; name: string; place: string }
  | { kind: "delete"; name: string };

const nameOf = (location: ParsedContextLocation | null | undefined) =>
  (location && documentTitleFromUri(location.path)) || t`Untitled document`;

/** The item's move or delete, if its branch has one; a creation has no tree line. */
export function treeLineOf(
  item: Pick<ThreadDraftListItem, "tree" | "contextLocation" | "documentName">,
): TreeLine | null {
  const { tree } = item;
  if (tree?.deleted)
    return { kind: "delete", name: item.documentName || nameOf(item.contextLocation) };
  if (!tree?.movedFrom || !item.contextLocation) return null;
  const move = describeMove(tree.movedFrom, item.contextLocation);
  return { kind: move.kind, name: nameOf(tree.movedFrom), place: move.place };
}

/** Whether the item's rows include a move or delete line. */
export function hasTreeLine(
  item: Pick<ThreadDraftListItem, "tree" | "contextLocation" | "documentName" | "isNew">,
): boolean {
  return !item.isNew && treeLineOf(item) !== null;
}

/** The tree line as a review row: one change with no text frame, keyed apart from text. */
export function treeChange(
  item: Pick<ThreadDraftListItem, "itemKey">,
  line: TreeLine,
): ReviewChange {
  return {
    id: `tree:${item.itemKey}`,
    kind: "change",
    excerpt:
      line.kind === "delete"
        ? { removed: line.name, inserted: "" }
        : { removed: "", inserted: line.place },
    byline: [],
    chats: [],
    members: [],
    attributed: false,
    anchor: 0,
    spans: [],
    frame: null,
    tree: line,
  };
}

/** "ch12: renaming to ch12-old", "ch13: Deleted". */
export function treeLineSentence(line: TreeLine): string {
  const { name } = line;
  switch (line.kind) {
    case "rename":
      return t`${name}: renaming to ${line.place}`;
    case "move":
      return t`${name}: moving to ${line.place}`;
    case "delete":
      return t`${name}: Deleted`;
  }
}

/** One branch's tree change to the live document, in the words of its Work notice. */
export type PendingTreeChange = {
  work: string | null;
  line: Exclude<DocumentDraftHint["tree"], null>;
};

/** "Ascension is renaming this to ch12-old." A chat with no Work is "A chat". */
export function treeNoticeSentence(
  change: PendingTreeChange,
  from: ParsedContextLocation | null,
): string {
  const { work } = change;
  if ("deleted" in change.line)
    return work ? t`${work} is deleting this.` : t`A chat is deleting this.`;
  const move = from ? describeMove(from, change.line.movedTo) : null;
  const place = move?.place ?? nameOf(change.line.movedTo);
  if (move?.kind === "rename")
    return work
      ? t`${work} is renaming this to ${place}.`
      : t`A chat is renaming this to ${place}.`;
  return work ? t`${work} is moving this to ${place}.` : t`A chat is moving this to ${place}.`;
}

/** The notice's short form, for a slot too narrow for the sentence. */
export function treeNoticeLabel(
  changes: readonly PendingTreeChange[],
  from: ParsedContextLocation | null,
): string {
  const [only] = changes;
  if (changes.length > 1 || !only) return t`Pending moves and deletes`;
  if ("deleted" in only.line) return t`Pending delete`;
  return from && describeMove(from, only.line.movedTo).kind === "rename"
    ? t`Pending rename`
    : t`Pending move`;
}
