import type { ParsedContent } from "@meridian/markup";
import { withBlockIds, withoutBlockIds } from "@meridian/prosemirror-schema";
import type { Fragment, Mark, Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import type { BlockRef } from "../handles.js";
import { toRef, unwrapBlock, unwrapDoc } from "../handles.js";
import type {
  AgentEditModel,
  ContentLineage,
  EditOp,
  EditOpsResult,
  ProjectedBlock,
} from "../ports/model.js";
import {
  blockHashesForDoc,
  blockIdentityForItem,
  fullHashForItemId,
  getBlockHash,
  getBlockItemId,
  getTopLevelXmlBlocks,
  isLiveXmlElement,
  uniqueHashesForBlocks,
} from "./block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./prosemirror-fragment.js";
import { readRepairedRoot } from "./schema-repair.js";

export type YProsemirrorDocumentModel = AgentEditModel & {
  schema: Schema;
};

export function yProsemirrorModel(schema: Schema): YProsemirrorDocumentModel {
  return {
    schema,

    getBlocks(doc) {
      return getTopLevelXmlBlocks(unwrapDoc(doc)).map(toRef);
    },

    getBlockId(block) {
      return getBlockHash(unwrapBlock(block));
    },

    getCanonicalBlockIdentity(block) {
      return getBlockItemId(unwrapBlock(block));
    },

    getDocumentBlockIds(doc) {
      return blockHashesForDoc(unwrapDoc(doc));
    },

    isLive(block) {
      return isLiveXmlElement(unwrapBlock(block));
    },

    getBlockType(block) {
      return unwrapBlock(block).nodeName;
    },

    getHeadingLevel(block) {
      const element = unwrapBlock(block);
      if (element.nodeName !== "paragraph") return undefined;
      const level = element.getAttribute("level");
      return level == null ? undefined : Number(level);
    },

    getText(block) {
      return collectText(unwrapBlock(block));
    },

    nodeLineage(block, path) {
      return collectVisibleContentLineage(nodeAt(unwrapBlock(block), path));
    },

    textblockLineage(block, path, from, to) {
      return textblockLineage(nodeAt(unwrapBlock(block), path), from, to);
    },

    transact(doc, fn, origin) {
      unwrapDoc(doc).transact(fn, origin);
    },

    encodeStateVector(doc) {
      return Y.encodeStateVector(unwrapDoc(doc));
    },

    applyUpdate(doc, update, origin) {
      Y.applyUpdate(unwrapDoc(doc), update, origin);
    },

    insertBlocks(doc, after, parsed) {
      return insertBlocks(unwrapDoc(doc), after ? unwrapBlock(after) : null, parsed).map(toRef);
    },

    deleteBlock(doc, block) {
      deleteBlock(unwrapDoc(doc), unwrapBlock(block));
    },

    applyOps(_doc, block, ops) {
      return applyOps(unwrapBlock(block), ops);
    },

    projectBlocks(doc) {
      return projectBlocks(unwrapDoc(doc), schema);
    },
  };
}

export function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
}

/**
 * One walk that pairs each top-level element with its node. Building the root repairs the
 * document (an element the schema can't build is deleted and dropped), so the surviving
 * elements are read after it and are exactly the ones that produced nodes; hashes are
 * computed over them, never over the pre-repair list.
 */
function projectBlocks(doc: Y.Doc, schema: Schema): ProjectedBlock[] {
  const root = readRepairedRoot("projectBlocks", fragmentOf(doc), schema);
  const elements = getTopLevelXmlBlocks(doc);
  if (elements.length !== root.childCount) {
    throw new Error(
      `Projection lost alignment: ${elements.length} elements for ${root.childCount} nodes`,
    );
  }
  const hashes = uniqueHashesForBlocks(elements);
  return elements.map((element, index) => ({
    ref: toRef(element),
    id: getBlockItemId(element),
    hash: hashes[index],
    fullHash: fullHashForItemId(blockIdentityForItem(doc, getBlockItemId(element))),
    // The model reads and writes Markdown, which has no ids, so its view of a block has none: a
    // block it leaves alone compares equal to its own Markdown and keeps its element and id.
    node: withoutBlockIds(root.child(index)),
  }));
}

/** An operation with the elements it addresses, found before anything changed. */
type Resolved =
  | { op: Extract<EditOp, { kind: "text" }>; node: Y.XmlElement }
  | { op: Extract<EditOp, { kind: "attrs" }>; node: Y.XmlElement }
  | { op: Extract<EditOp, { kind: "insert" }>; node: Y.XmlElement; anchor: Y.XmlElement | null }
  | { op: Extract<EditOp, { kind: "delete" }>; node: Y.XmlElement };

/**
 * Every path and offset is checked before anything changes, so an operation means the
 * block as planned whatever ran before it, and a write that does not fit leaves it alone.
 * Text and attributes go first, then inserts (each after an element found beforehand, which
 * a delete may remove next), then deletes.
 */
export function applyOps(block: Y.XmlElement, ops: readonly EditOp[]): EditOpsResult {
  const resolved: Resolved[] = [];
  for (const op of ops) {
    const node = findNode(block, op.path);
    const problem = node ? opProblem(node, op) : "its path does not address an element";
    if (!node || problem) return invalidOp(`Cannot apply a ${op.kind} operation: ${problem}`);
    if (op.kind === "insert") {
      const anchor = op.after < 0 ? null : node.get(op.after);
      resolved.push({ op, node, anchor: anchor instanceof Y.XmlElement ? anchor : null });
    } else if (op.kind === "attrs" && op.unit !== undefined) {
      resolved.push({ op, node: atomAt(node, op.unit) ?? node });
    } else resolved.push({ op, node } as Resolved);
  }
  const of = <K extends EditOp["kind"]>(kind: K) =>
    resolved.filter(
      (entry): entry is Extract<Resolved, { op: { kind: K } }> => entry.op.kind === kind,
    );
  for (const { op, node } of of("text")) applyTextOp(node, op);
  for (const { op, node } of of("attrs"))
    for (const [key, value] of Object.entries(op.attrs)) {
      if (value === null || value === undefined) node.removeAttribute(key);
      else node.setAttribute(key, value as string);
    }
  for (const { op, node, anchor } of of("insert"))
    node.insert(
      anchor ? node.toArray().indexOf(anchor) + 1 : 0,
      op.nodes.map((child) => pmNodeToYElement(withBlockIds(child))),
    );
  for (const { node } of of("delete")) {
    const parent = node.parent as Y.XmlElement;
    parent.delete(parent.toArray().indexOf(node), 1);
  }
  return { ok: true };
}

function invalidOp(message: string): EditOpsResult {
  return { ok: false, code: "invalid_write", message };
}

/** A textblock's child laid out in units: a run of text, or one inline atom. */
interface Slot {
  child: Y.XmlText | Y.XmlElement;
  /** Index among the textblock's live children. */
  index: number;
  start: number;
  length: number;
}

function slotsOf(leaf: Y.XmlElement): Slot[] {
  const slots: Slot[] = [];
  let start = 0;
  for (const [index, child] of leaf.toArray().entries()) {
    if (!(child instanceof Y.XmlText || child instanceof Y.XmlElement)) continue;
    const length = child instanceof Y.XmlText ? child.length : 1;
    slots.push({ child, index, start, length });
    start += length;
  }
  return slots;
}

/** An empty text is zero units wide and shares its unit with the atom after it, so only an atom counts. */
function atomAt(leaf: Y.XmlElement, unit: number): Y.XmlElement | undefined {
  const slot = slotsOf(leaf).find(
    (candidate) => candidate.start === unit && candidate.child instanceof Y.XmlElement,
  );
  return slot?.child as Y.XmlElement | undefined;
}

/** Why `op` cannot be applied to `node`, if it cannot. */
function opProblem(node: Y.XmlElement, op: EditOp): string | undefined {
  if (op.kind === "attrs")
    return op.unit === undefined || atomAt(node, op.unit) ? undefined : "no atom at its unit";
  if (op.kind === "insert")
    return op.after < 0 || node.get(op.after) instanceof Y.XmlElement
      ? undefined
      : "no child to insert after";
  if (op.kind === "delete")
    return op.path.length > 0 ? undefined : "a block does not delete itself";
  const slots = slotsOf(node);
  const size = slots.reduce((sum, slot) => sum + slot.length, 0);
  let cursor = 0;
  for (const { from, to } of op.splices) {
    if (from < cursor || to < from || to > size) return `invalid splice ${from}..${to} of ${size}`;
    cursor = to;
  }
  for (const { from, to } of op.formats)
    if (from < 0 || to <= from || to > size)
      return `invalid format range ${from}..${to} of ${size}`;
  return undefined;
}

/** Units are addressed across the textblock's children, as `slotsOf` lays them out. */
function applyTextOp(leaf: Y.XmlElement, op: Extract<EditOp, { kind: "text" }>): void {
  if (leaf.length === 0) leaf.insert(0, [new Y.XmlText()]);
  // Formats don't move offsets, so they go first.
  for (const { from, to, mark, attrs } of op.formats)
    for (const { child, start, length } of slotsOf(leaf)) {
      const lo = Math.max(from, start);
      const hi = Math.min(to, start + length);
      if (child instanceof Y.XmlText && lo < hi)
        child.format(lo - start, hi - lo, { [mark]: attrs });
    }
  // Right to left, so earlier offsets stay where they were planned.
  for (const { from, to, content } of [...op.splices].reverse()) {
    let deleted = 0;
    for (const { child, index, start, length } of slotsOf(leaf).reverse()) {
      const lo = Math.max(from, start);
      const hi = Math.min(to, start + length);
      if (lo >= hi) continue;
      if (child instanceof Y.XmlText) {
        child.delete(lo - start, hi - lo);
        deleted += hi - lo;
      } else {
        leaf.delete(index, 1);
        deleted += 1;
      }
    }
    insertContent(leaf, to - deleted, content);
  }
}

/** Put inline `content` at unit `at`: into the run of text it touches, else as new children. */
function insertContent(leaf: Y.XmlElement, at: number, content: Fragment): void {
  if (content.size === 0) return;
  const texts: PMNode[][] = [[]];
  const atoms: PMNode[] = [];
  content.forEach((node) => {
    if (node.isText) texts[texts.length - 1].push(node);
    else {
      atoms.push(node);
      texts.push([]);
    }
  });
  const slots = slotsOf(leaf);
  const runs = slots.filter(
    (slot): slot is Slot & { child: Y.XmlText } => slot.child instanceof Y.XmlText,
  );
  const insertInto = (run: Y.XmlText, offset: number, nodes: readonly PMNode[]) => {
    let position = offset;
    for (const node of nodes) {
      run.insert(position, node.text ?? "", marksToAttributes(node.marks) ?? {});
      position += node.text?.length ?? 0;
    }
  };
  // The first run that reaches the offset, so an insert at a boundary joins the earlier run.
  if (atoms.length === 0) {
    const run = runs.find((slot) => slot.start <= at && at <= slot.start + slot.length);
    if (run) insertInto(run.child, at - run.start, texts[0]);
    else
      leaf.insert(slots.filter((slot) => slot.start + slot.length <= at).length, [
        textNodesToYText(texts[0]),
      ]);
    return;
  }
  // An atom cannot go inside a run of text, so the run is cut there: its tail moves to a run
  // of its own after the atom, the way a peer's typed break would split it.
  const inside = runs.find((slot) => slot.start < at && at < slot.start + slot.length);
  let tail: Y.XmlText | undefined;
  if (inside) {
    tail = new Y.XmlText();
    let seen = 0;
    let end = 0;
    for (const part of inside.child.toDelta() as Array<{
      insert: string;
      attributes?: Record<string, unknown>;
    }>) {
      const skip = Math.max(0, at - inside.start - seen);
      seen += part.insert.length;
      if (skip >= part.insert.length) continue;
      const rest = part.insert.slice(skip);
      tail.insert(end, rest, part.attributes);
      end += rest.length;
    }
    inside.child.delete(at - inside.start, inside.length - (at - inside.start));
  }
  const previous =
    inside ?? runs.find((slot) => slot.length > 0 && slot.start + slot.length === at);
  const next: { child: Y.XmlText } | undefined = tail
    ? { child: tail }
    : runs.find((slot) => slot.length > 0 && slot.start === at);
  const children: Array<Y.XmlText | Y.XmlElement> = [];
  for (const [index, nodes] of texts.entries()) {
    if (index > 0) children.push(pmNodeToYElement(atoms[index - 1]));
    if (nodes.length === 0) continue;
    if (index === 0 && previous) insertInto(previous.child, at - previous.start, nodes);
    else if (index === texts.length - 1 && next) insertInto(next.child, 0, nodes);
    else children.push(textNodesToYText(nodes));
  }
  if (tail) children.push(tail);
  const anchor = inside ?? undefined;
  leaf.insert(
    anchor
      ? anchor.index + 1
      : slots.filter((slot) => slot !== next && slot.start + slot.length <= at).length,
    children,
  );
}

export function insertBlocks(
  doc: Y.Doc,
  after: Y.XmlElement | BlockRef | null,
  parsed: ParsedContent,
): Y.XmlElement[] {
  const fragment = fragmentOf(doc);
  const blocks = getTopLevelXmlBlocks(doc);
  const afterElement = after === null ? null : unwrapBlock(toRef(after));
  const index = afterElement === null ? 0 : blocks.indexOf(afterElement) + 1;
  if (afterElement !== null && index === 0) {
    throw new Error("Cannot insert after a block that is not in the document");
  }
  // The codec's blocks have no ids: this is where they become stored blocks.
  const inserted = parsed.blocks.map((block) => pmNodeToYElement(withBlockIds(block)));
  if (inserted.length > 0) fragment.insert(index, inserted);
  return inserted;
}

export function deleteBlock(doc: Y.Doc, block: Y.XmlElement | BlockRef): void {
  block = unwrapBlock(toRef(block));
  const fragment = fragmentOf(doc);
  const blocks = getTopLevelXmlBlocks(doc);
  const index = blocks.indexOf(block);
  if (index < 0) throw new Error("Cannot delete a block that is not in the document");
  if (blocks.length === 1) {
    clearText(block);
    return;
  }
  fragment.delete(index, 1);
}

function collectText(type: Y.XmlElement | Y.XmlText): string {
  if (type instanceof Y.XmlText) return yTextPlainText(type);
  return type
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || child instanceof Y.XmlElement ? collectText(child) : "",
    )
    .join("");
}

/**
 * Yjs splits text items at deletion boundaries while preserving their item
 * clocks. Expanding the live string items into clock units therefore gives us
 * stable character ancestry without comparing prose or attributing update bytes.
 */
function collectVisibleContentLineage(block: Y.XmlElement): ContentLineage[] {
  const lineage: ContentLineage[] = [];
  const visit = (type: Y.XmlElement | Y.XmlText) => {
    if (type instanceof Y.XmlText) {
      for (let item = type._start; item; item = item.right) {
        if (!item.deleted && item.content instanceof Y.ContentString) {
          lineage.push({
            clientID: item.id.client,
            clock: item.id.clock,
            length: item.length,
          });
        }
      }
      return;
    }
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(block);
  return lineage;
}

function textblockLineage(leaf: Y.XmlElement, from: number, to: number): ContentLineage[] {
  const lineage: ContentLineage[] = [];
  for (const { child, start, length } of slotsOf(leaf)) {
    if (!(child instanceof Y.XmlText)) continue;
    const lo = Math.max(from, start);
    const hi = Math.min(to, start + length);
    if (lo >= hi) continue;
    // Units of a run are its live items' characters, in order.
    let at = start;
    for (let item = child._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
      const a = Math.max(lo, at);
      const b = Math.min(hi, at + item.length);
      if (a < b)
        lineage.push({ clientID: item.id.client, clock: item.id.clock + a - at, length: b - a });
      at += item.length;
    }
  }
  return lineage;
}

/** The element at `path` under `block`, or undefined when the path leaves the elements. */
function findNode(block: Y.XmlElement, path: readonly number[]): Y.XmlElement | undefined {
  let node = block;
  for (const index of path) {
    const child = node.get(index);
    if (!(child instanceof Y.XmlElement)) return undefined;
    node = child;
  }
  return node;
}

function nodeAt(block: Y.XmlElement, path: readonly number[]): Y.XmlElement {
  const node = findNode(block, path);
  if (!node) throw new Error(`Path ${path.join("/")} does not address an element`);
  return node;
}

function yTextPlainText(text: Y.XmlText): string {
  return (text.toDelta() as Array<{ insert?: unknown }>)
    .map((delta) => (typeof delta.insert === "string" ? delta.insert : ""))
    .join("");
}

function clearText(type: Y.XmlElement | Y.XmlText): void {
  if (type instanceof Y.XmlText) {
    type.delete(0, type.length);
    return;
  }
  for (const child of type.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) clearText(child);
  }
}

export function pmNodeToYElement(node: PMNode): Y.XmlElement {
  const element = new Y.XmlElement(node.type.name);
  for (const key of Object.keys(node.attrs)) {
    const value = node.attrs[key];
    if (value !== null && key !== "ychange") element.setAttribute(key, value);
  }
  const children = normalizeContent(node).map((child) =>
    Array.isArray(child) ? textNodesToYText(child) : pmNodeToYElement(child),
  );
  if (children.length > 0) element.insert(0, children);
  return element;
}

function textNodesToYText(nodes: readonly PMNode[]): Y.XmlText {
  const text = new Y.XmlText();
  text.applyDelta(
    nodes.map((node) => ({
      insert: node.text ?? "",
      attributes: marksToAttributes(node.marks),
    })),
  );
  return text;
}

function normalizeContent(node: PMNode): Array<PMNode | PMNode[]> {
  const children: Array<PMNode | PMNode[]> = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!child.isText) {
      children.push(child);
      continue;
    }
    const texts: PMNode[] = [child];
    while (index + 1 < node.childCount && node.child(index + 1).isText) {
      index += 1;
      texts.push(node.child(index));
    }
    children.push(texts);
  }
  return children;
}

function marksToAttributes(marks: readonly Mark[]): Record<string, unknown> | undefined {
  if (marks.length === 0) return undefined;
  const attrs: Record<string, unknown> = {};
  for (const mark of marks) attrs[mark.type.name] = mark.attrs;
  return attrs;
}
