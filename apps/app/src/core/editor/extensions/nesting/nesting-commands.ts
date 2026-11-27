import {
  type BlockFacts,
  extentOf,
  innermostListStep,
  itemStart,
  nestNodes,
  pathOf,
  readPath,
  sharedSteps,
} from "@meridian/prosemirror-schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";

export type ListKindName = "bullet" | "ordered";

export const NO_LIST = { kind: null, marker: null, start: null, loose: null } as const;

export const MAX_LIST_DEPTH = 8;

type Sequence = {
  blocks: ProseMirrorNode[];
  positions: number[];
  facts: BlockFacts[];
  from: number;
  to: number;
};

export function selectedSequence(selection: Transaction["selection"]): Sequence {
  const { $from, $to } = selection;
  const textDepth =
    selection instanceof NodeSelection || !$from.parent.isTextblock ? $from.depth + 1 : $from.depth;
  const depth = Math.max(0, Math.min($from.sharedDepth($to.pos), textDepth - 1));
  const container = $from.node(depth);
  const blocks: ProseMirrorNode[] = [];
  const positions: number[] = [];
  let at = $from.start(depth);
  container.forEach((child) => {
    blocks.push(child);
    positions.push(at);
    at += child.nodeSize;
  });
  // A gap cursor stands between blocks and covers the one after it; at the container's end
  // there is none, so it covers the one before (a document ending in a table).
  const from = Math.min($from.index(depth), blocks.length - 1);
  const last = selection instanceof NodeSelection ? from + 1 : $to.indexAfter(depth);
  return {
    blocks,
    positions,
    facts: nestNodes(blocks),
    from,
    to: Math.max(last, from + 1),
  };
}

function write(tr: Transaction, sequence: Sequence, index: number, attrs: Record<string, unknown>) {
  const block = sequence.blocks[index];
  tr.setNodeMarkup(sequence.positions[index], undefined, { ...block.attrs, ...attrs });
}

function selectedItems(sequence: Sequence): number[] {
  const starts = new Set<number>();
  for (let i = sequence.from; i < sequence.to; i++) {
    if (innermostListStep(sequence.facts[i].steps) >= 0) starts.add(itemStart(sequence.facts, i));
  }
  return [...starts];
}

export function selectionListKind(sequence: Sequence): ListKindName | null {
  let kind: ListKindName | null = null;
  for (let i = sequence.from; i < sequence.to; i++) {
    const level = innermostListStep(sequence.facts[i].steps);
    if (level < 0) return null;
    const own = sequence.facts[i].steps[level].list?.kind ?? "bullet";
    if (kind !== null && kind !== own) return null;
    kind = own;
  }
  return kind;
}

export function setList(
  tr: Transaction,
  kind: ListKindName,
  { keepKind = false }: { keepKind?: boolean } = {},
): boolean {
  const sequence = selectedSequence(tr.selection);
  let changed = false;
  for (let i = sequence.from; i < sequence.to; i++) {
    const facts = sequence.facts[i];
    const level = innermostListStep(facts.steps);
    const own = { kind: kind === "ordered" ? "ordered" : null };
    if (keepKind && level >= 0) continue;
    if (level < 0) {
      const steps = readPath(sequence.blocks[i].attrs.path);
      steps.push({ type: "list", fresh: false });
      const level0 = sequence.blocks[i].type.name === "paragraph" ? { level: null } : {};
      write(tr, sequence, i, { path: pathOf(steps), marker: "item", ...own, ...level0 });
      changed = true;
    } else if (facts.steps[level].startsItem) {
      write(tr, sequence, i, own);
      changed = true;
    }
  }
  return changed;
}

export function selectionIsTaskList(sequence: Sequence): boolean {
  for (let i = sequence.from; i < sequence.to; i++) {
    const marker = sequence.facts[itemStart(sequence.facts, i)].marker;
    if (marker !== "todo" && marker !== "done") return false;
  }
  return true;
}

export function setTaskList(tr: Transaction): boolean {
  let changed = setList(tr, selectionListKind(selectedSequence(tr.selection)) ?? "bullet", {
    keepKind: true,
  });
  const sequence = selectedSequence(tr.selection);
  for (const start of selectedItems(sequence)) {
    const marker = sequence.blocks[start].attrs.marker;
    if (marker === "todo" || marker === "done") continue;
    write(tr, sequence, start, { marker: "todo" });
    changed = true;
  }
  return changed;
}

export function unsetList(tr: Transaction): boolean {
  let changed = false;
  // Each pass lifts the selected items one level, so the depth bounds the loop.
  for (let guard = 64; guard > 0 && outdent(tr); guard--) changed = true;
  return changed;
}

export function indent(tr: Transaction): boolean {
  const sequence = selectedSequence(tr.selection);
  let changed = false;
  for (const start of selectedItems(sequence)) {
    const level = innermostListStep(sequence.facts[start].steps);
    const step = sequence.facts[start].steps[level];
    if (!step.startsItem || step.opens) continue;
    const depth = sequence.facts[start].steps.filter((s) => s.type === "list").length;
    if (depth >= MAX_LIST_DEPTH) continue;
    const [from, to] = extentOf(sequence.facts, start);
    for (let i = from; i < to; i++) {
      const steps = readPath(sequence.blocks[i].attrs.path);
      steps.splice(level + 1, 0, { type: "list", fresh: false });
      write(tr, sequence, i, { path: pathOf(steps) });
    }
    changed = true;
  }
  return changed;
}

export function outdent(tr: Transaction): boolean {
  const sequence = selectedSequence(tr.selection);
  let changed = false;
  for (const start of selectedItems(sequence)) {
    const level = innermostListStep(sequence.facts[start].steps);
    const [from, to] = extentOf(sequence.facts, start);
    for (let i = from; i < to; i++) {
      const steps = readPath(sequence.blocks[i].attrs.path);
      steps.splice(level, 1);
      const path = pathOf(steps);
      const stillListed = steps.some((s) => s.type === "list");
      write(tr, sequence, i, stillListed ? { path } : { path, ...NO_LIST });
    }
    changed = true;
  }
  return changed;
}

export function selectionIsQuoted(sequence: Sequence): boolean {
  for (let i = sequence.from; i < sequence.to; i++) {
    if (!sequence.facts[i].steps.some((step) => step.type === "quote")) return false;
  }
  return true;
}

export function quote(tr: Transaction): boolean {
  const sequence = selectedSequence(tr.selection);
  const { from, to } = sequence;
  const at = sharedSteps(sequence.facts, from, to);
  const paths = sequence.blocks.map((block) => readPath(block.attrs.path));
  for (let i = from; i < to; i++) paths[i].splice(at, 0, { type: "quote", fresh: false });
  const reading = () =>
    nestNodes(
      sequence.blocks.map((block, i) => ({
        type: block.type,
        attrs: { ...block.attrs, path: pathOf(paths[i]) },
      })),
    );
  if (!reading()[from].steps[at].opens) paths[from][at].fresh = true;
  const below = reading()[to]?.steps[at];
  const splitsBelow = below?.type === "quote" && !below.opens;
  if (splitsBelow) paths[to][at].fresh = true;
  for (let i = from; i < (splitsBelow ? to + 1 : to); i++) {
    write(tr, sequence, i, { path: pathOf(paths[i]) });
  }
  return to > from;
}

export function unquote(tr: Transaction): boolean {
  const sequence = selectedSequence(tr.selection);
  const shared = sequence.facts[sequence.from].steps
    .slice(0, sharedSteps(sequence.facts, sequence.from, sequence.to))
    .map((step) => step.type)
    .lastIndexOf("quote");
  let changed = false;
  for (let i = sequence.from; i < sequence.to; i++) {
    const steps = readPath(sequence.blocks[i].attrs.path);
    const at = shared >= 0 ? shared : steps.map((step) => step.type).lastIndexOf("quote");
    if (at < 0) continue;
    steps.splice(at, 1);
    write(tr, sequence, i, { path: pathOf(steps) });
    changed = true;
  }
  return changed;
}
