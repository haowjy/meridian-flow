/**
 * Keeps block ids right from the transaction. Tiptap's `splitBlock` copies a block's attributes to
 * both halves and a paste brings the copied blocks' ids along, so after a local change a block can
 * have no id or share one. The block that was already there keeps the id: the one the old document's
 * block maps to. A split's first half is that block, except when Enter was pressed at the start and
 * left it empty, where the half that holds the text is. A block holding another parent's
 * empty-paragraph id (`c/empty` after an unwrap of `c`) takes a fresh one: that id names only `c`'s
 * empty paragraph, which every peer derives again whenever `c` shows empty (design §1).
 */

import { emptyParagraphOf } from "@meridian/document-model";
import { loroSyncKey, REMOTE_META } from "@meridian/loro-prosemirror";
import { hasBlockId, newBlockId } from "@meridian/prosemirror-schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";

type Placed = { node: ProseMirrorNode; pos: number; parent: string | null };

function blocksOf(doc: ProseMirrorNode): Placed[] {
  const out: Placed[] = [];
  doc.descendants((node, pos, parent) => {
    if (hasBlockId(node))
      out.push({ node, pos, parent: parent === doc ? null : (parent?.attrs.id ?? null) });
    return !node.isTextblock;
  });
  return out;
}

/**
 * Typing, deleting inside one textblock and marks never change which blocks there are. Except in a
 * block with no id: the empty document's one paragraph is that until its first keystroke, which
 * would otherwise store it with none.
 */
function keepsBlocks(transaction: Transaction): boolean {
  return transaction.steps.every((step, index) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const { from, to, slice } = step;
    const before = transaction.docs[index];
    return (
      slice.openStart === 0 &&
      slice.openEnd === 0 &&
      slice.content.childCount <= 1 &&
      (slice.content.firstChild?.isText ?? true) &&
      before.resolve(from).parent.isTextblock &&
      before.resolve(from).parent.attrs.id !== null &&
      before.resolve(from).sameParent(before.resolve(to))
    );
  });
}

/** A change the Loro binding applied: a peer's, an undo or the first load. Its blocks already have their ids. */
function fromBinding(transaction: Transaction): boolean {
  return transaction.getMeta(loroSyncKey) === REMOTE_META;
}

/**
 * Gives the blocks `transaction` leaves in the document their ids, by adding the attribute steps to
 * the transaction itself. A second transaction would reset the input rule it follows, and with it
 * Backspace's undo of that rule.
 */
export function fixBlockIds(transaction: Transaction, oldState: EditorState): void {
  if (!transaction.docChanged || fromBinding(transaction) || keepsBlocks(transaction)) return;

  // Where each id's block from the old document stands now.
  const owners = new Map<string, number>();
  for (const { node, pos } of blocksOf(oldState.doc)) {
    const id = node.attrs.id as string | null;
    if (id == null) continue;
    // Content inserted at the block's start goes before it (assoc 1). A block whose own tokens were
    // replaced (`setNodeMarkup`) reads as deleted, but a block with this id still stands at its start.
    const mapped = transaction.mapping.mapResult(pos, 1);
    const at = mapped.deleted ? transaction.mapping.map(pos, -1) : mapped.pos;
    if (transaction.doc.nodeAt(at)?.attrs.id === id) owners.set(id, at);
  }

  // Enter at the start of a block leaves its empty first half where the block was; the text moves on.
  for (const [id, pos] of owners) {
    const node = transaction.doc.nodeAt(pos);
    const next = transaction.doc.nodeAt(pos + (node?.nodeSize ?? 0));
    if (
      node?.isTextblock &&
      node.content.size === 0 &&
      next?.attrs.id === id &&
      next.content.size > 0
    ) {
      owners.set(id, pos + node.nodeSize);
    }
  }

  const claimed = new Set<string>();
  for (const { node, pos, parent } of blocksOf(transaction.doc)) {
    const id = node.attrs.id as string | null;
    const derived = id == null ? undefined : emptyParagraphOf(id);
    const owner =
      id != null &&
      (derived === undefined || derived === parent) &&
      (owners.get(id) === pos || (!owners.has(id) && !claimed.has(id)));
    if (owner) claimed.add(id as string);
    else transaction.setNodeAttribute(pos, "id", newBlockId());
  }
}
