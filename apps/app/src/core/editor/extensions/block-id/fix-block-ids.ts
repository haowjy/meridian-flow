import { loroSyncKey, REMOTE_META } from "@meridian/loro-prosemirror";
import { hasBlockId, newBlockId } from "@meridian/prosemirror-schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";

function blocksOf(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; pos: number }> {
  const out: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (hasBlockId(node)) out.push({ node, pos });
    return !node.isTextblock;
  });
  return out;
}

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
  for (const { node, pos } of blocksOf(transaction.doc)) {
    const id = node.attrs.id as string | null;
    const owner = id != null && (owners.get(id) === pos || (!owners.has(id) && !claimed.has(id)));
    if (owner) claimed.add(id as string);
    else transaction.setNodeAttribute(pos, "id", newBlockId());
  }
}
