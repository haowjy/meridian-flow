import { InputRule } from "@tiptap/core";
import type { Attrs, NodeType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/**
 * What `node` keeps when it becomes `type`, with `attrs` on top: its id, its place in quotes and
 * lists and every other attribute `type` also has. Every door that
 * changes a block's type goes through here; ProseMirror's `setBlockType` and TipTap's `setNode`
 * start from defaults.
 */
function retypedAttrs(node: ProseMirrorNode, type: NodeType, attrs: Attrs = {}): Attrs {
  const kept: Record<string, unknown> = {};
  for (const name of Object.keys(type.spec.attrs ?? {})) {
    if (name in node.attrs) kept[name] = node.attrs[name];
  }
  return { ...kept, ...attrs };
}

export function setBlockType(
  tr: Transaction,
  from: number,
  to: number,
  type: NodeType,
  attrs: Attrs = {},
): boolean {
  const before = tr.steps.length;
  const retyped: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const next = retypedAttrs(node, type, attrs);
    if (node.type !== type) retyped.push(pos);
    else if (!node.hasMarkup(type, next)) tr.setNodeMarkup(pos, type, next);
    return false;
  });
  for (const pos of retyped) {
    const at = tr.mapping.slice(before).map(pos) + 1;
    tr.setBlockType(at, at, type, (node) => retypedAttrs(node, type, attrs));
  }
  return tr.steps.length > before;
}

export function replaceBlock(tr: Transaction, pos: number, made: ProseMirrorNode, attrs: Attrs) {
  const current = tr.doc.nodeAt(pos);
  if (!current) return;
  const kept = retypedAttrs(current, made.type, attrs);
  // Same type: change attributes only, so the block keeps its text and a peer's typing.
  if (current.type === made.type && current.content.eq(made.content)) {
    tr.setNodeMarkup(pos, undefined, kept);
  } else {
    tr.replaceWith(pos, pos + current.nodeSize, made.type.create(kept, made.content, made.marks));
  }
}

export function blockTypeInputRule(config: {
  find: RegExp;
  type: NodeType;
  getAttributes: (match: RegExpMatchArray) => Attrs;
}) {
  return new InputRule({
    find: config.find,
    handler: ({ state, range, match }) => {
      const $start = state.doc.resolve(range.from);
      if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), config.type)) {
        return null;
      }
      const tr = state.tr.delete(range.from, range.to);
      setBlockType(tr, range.from, range.from, config.type, config.getAttributes(match));
    },
  });
}
