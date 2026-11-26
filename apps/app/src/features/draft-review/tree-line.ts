import { t } from "@lingui/core/macro";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { DocumentDraftHint, DraftItem } from "@meridian/contracts/drafts";
import { describeMove, type ParsedContextLocation } from "@/features/chat/document-display-name";

export type TreeLine =
  | { kind: "rename" | "move" | "reorder"; name: string; place: string }
  | { kind: "delete"; name: string };

const nameOf = (location: ParsedContextLocation | null | undefined) =>
  (location && documentTitleFromUri(location.path)) || t`Untitled document`;

export function treeLineOf(
  item: Pick<DraftItem, "tree" | "contextLocation" | "documentName">,
): TreeLine | null {
  const { tree } = item;
  if (tree?.deleted)
    return { kind: "delete", name: item.documentName || nameOf(item.contextLocation) };
  if (!tree?.movedFrom || !item.contextLocation) return null;
  const move = describeMove(tree.movedFrom, item.contextLocation);
  return { kind: move.kind, name: nameOf(tree.movedFrom), place: move.place };
}

export function hasTreeLine(
  item: Pick<DraftItem, "tree" | "contextLocation" | "documentName" | "isNew">,
): boolean {
  return !item.isNew && treeLineOf(item) !== null;
}

export function hasApply(
  item: Pick<DraftItem, "tree" | "contextLocation" | "documentName" | "isNew" | "pending">,
): boolean {
  return item.pending || item.isNew || hasTreeLine(item);
}

export function isTreeOnly(
  item: Pick<DraftItem, "tree" | "contextLocation" | "documentName" | "isNew" | "pending">,
): boolean {
  return item.tree?.deleted === true || (!item.pending && hasTreeLine(item));
}

export function opensAsDocument(
  item: Pick<
    DraftItem,
    "tree" | "contextLocation" | "documentName" | "isNew" | "pending" | "binary"
  >,
): boolean {
  return item.pending || (item.isNew && !item.binary) || isTreeOnly(item);
}

export type PendingTreeChange = {
  work: string | null;
  line: Exclude<DocumentDraftHint["tree"], null>;
};

export function treeNoticeSentence(
  change: PendingTreeChange,
  from: ParsedContextLocation | null,
): string {
  const { work } = change;
  if ("deleted" in change.line)
    return work ? t`${work} is deleting this.` : t`A chat is deleting this.`;
  const move = from ? describeMove(from, change.line.movedTo) : null;
  const place = move?.place ?? nameOf(change.line.movedTo);
  if (move?.kind === "reorder")
    return work ? t`${work} is reordering this.` : t`A chat is reordering this.`;
  if (move?.kind === "rename")
    return work
      ? t`${work} is renaming this to ${place}.`
      : t`A chat is renaming this to ${place}.`;
  return work ? t`${work} is moving this to ${place}.` : t`A chat is moving this to ${place}.`;
}

export function treeNoticeLabel(
  changes: readonly PendingTreeChange[],
  from: ParsedContextLocation | null,
): string {
  const [only] = changes;
  if (changes.length > 1 || !only) return t`Pending moves and deletes`;
  if ("deleted" in only.line) return t`Pending delete`;
  const kind = from ? describeMove(from, only.line.movedTo).kind : "move";
  return kind === "rename"
    ? t`Pending rename`
    : kind === "reorder"
      ? t`Pending reorder`
      : t`Pending move`;
}
