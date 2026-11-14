import type { ParsedContent } from "@meridian/markup";
import { withBlockIds, withoutBlockIds } from "@meridian/prosemirror-schema";
import { updateYFragment } from "@tiptap/y-tiptap";
import type { Fragment, Mark, Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import type { Span } from "../codec-types.js";
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

interface TextSegment {
  text: Y.XmlText;
  start: number;
  length: number;
}

type BindingMetadata = Parameters<typeof updateYFragment>[3];

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

    getVisibleContentLineage(block) {
      return collectVisibleContentLineage(unwrapBlock(block));
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

    applyTextEdit(_doc, block, span, newText) {
      applyTextEdit(unwrapBlock(block), span, newText);
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

    applyBlockReplacement(doc, block, replacement) {
      applyBlockDiff(unwrapDoc(doc), unwrapBlock(block), replacement);
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

export function applyTextEdit(block: Y.XmlElement | BlockRef, span: Span, newText: string): void {
  block = unwrapBlock(toRef(block));
  const text = collectText(block);
  if (span.from < 0 || span.to < span.from || span.to > text.length) {
    throw new RangeError(
      `Invalid text span ${span.from}..${span.to} for block length ${text.length}`,
    );
  }

  // Equal text at either edge stays, so its items, anchors and attribution survive.
  const trimmed = trimUnchangedEdges(text.slice(span.from, span.to), newText);
  span = { from: span.from + trimmed.prefix, to: span.to - trimmed.suffix };
  newText = trimmed.text;
  if (span.from === span.to && newText.length === 0) return;

  const segments = collectTextSegments(block);
  const insertAttrs = attributesAtFlatOffset(segments, span.from);

  // Insert before deleting: an insert into an already-deleted run anchors
  // after it, beside any writer text typed at its end, and Yjs then orders
  // the two by client id, which can put the writer's words in front.
  if (newText.length > 0) {
    const insertion = insertionPoint(block, segments, span.from);
    insertion.text.insert(insertion.offset, newText, insertAttrs);
  }
  const from = span.from + newText.length;
  const to = span.to + newText.length;
  for (const segment of collectTextSegments(block).reverse()) {
    const segmentFrom = Math.max(from, segment.start);
    const segmentTo = Math.min(to, segment.start + segment.length);
    if (segmentFrom < segmentTo) {
      segment.text.delete(segmentFrom - segment.start, segmentTo - segmentFrom);
    }
  }
}

function trimUnchangedEdges(
  oldText: string,
  newText: string,
): { prefix: number; suffix: number; text: string } {
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  // Never split a surrogate pair: Yjs would store each half as a broken character.
  if (prefix > 0 && isHighSurrogate(newText.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(newText.charCodeAt(newText.length - suffix))) suffix -= 1;
  return { prefix, suffix, text: newText.slice(prefix, newText.length - suffix) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Rewrites a block as `replacement` in place: its attributes are written and
 * its content is diffed against the current children, so equal text keeps its
 * items, anchors and attribution.
 */
export function applyBlockDiff(
  doc: Y.Doc,
  block: Y.XmlElement | BlockRef,
  replacement: PMNode,
): void {
  const element = unwrapBlock(toRef(block));
  if (element.nodeName !== replacement.type.name) {
    throw new Error(
      `Cannot update ${element.nodeName} block with ${replacement.type.name} content`,
    );
  }
  // A block the model rewrites whole is a new block to the merge: it takes a fresh id.
  writePmBlock(doc, element, withBlockIds(replacement));
}

function writePmBlock(doc: Y.Doc, block: Y.XmlElement, replacement: PMNode): void {
  updateYFragment(doc, block as unknown as Y.XmlFragment, replacement, createBindingMetadata());
}

/**
 * Every path and offset is checked before anything changes, so an operation means the
 * block as planned whatever ran before it, and a write that does not fit leaves it alone.
 */
function applyOps(block: Y.XmlElement, ops: readonly EditOp[]): EditOpsResult {
  const targets: Y.XmlElement[] = [];
  for (const op of ops) {
    const node = findNode(block, op.path);
    const problem = node ? opProblem(node, op) : "its path does not address an element";
    if (!node || problem) return invalidOp(`Cannot apply a ${op.kind} operation: ${problem}`);
    targets.push(
      op.kind === "attrs" && op.unit !== undefined ? (atomAt(node, op.unit) ?? node) : node,
    );
  }
  for (const [index, op] of ops.entries()) {
    const target = targets[index];
    if (op.kind === "text") {
      applyTextOp(target, op);
      continue;
    }
    for (const [key, value] of Object.entries(op.attrs)) {
      if (value === null || value === undefined) target.removeAttribute(key);
      else target.setAttribute(key, value as string);
    }
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
  const slots = slotsOf(node);
  const size = slots.reduce((sum, slot) => sum + slot.length, 0);
  const slotAt = (unit: number) =>
    slots.find((slot) => unit >= slot.start && unit < slot.start + slot.length);
  let cursor = 0;
  for (const { from, to, content } of op.splices) {
    if (from < cursor || to < from || to > size) return `invalid splice ${from}..${to} of ${size}`;
    let atoms = false;
    content.forEach((child) => {
      atoms ||= !child.isText;
    });
    // Replacing [from, to) leaves a run of text whole around the insertion point; an atom
    // cannot go into one, since a run of text cannot be cut in two.
    const inside = from > 0 && to < size ? slotAt(from - 1) : undefined;
    if (atoms && inside && inside === slotAt(to) && inside.child instanceof Y.XmlText)
      return "an inline atom cannot go inside a run of text";
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
  const previous = runs.find((slot) => slot.length > 0 && slot.start + slot.length === at);
  const next = runs.find((slot) => slot.length > 0 && slot.start === at);
  const children: Array<Y.XmlText | Y.XmlElement> = [];
  const meta = createBindingMetadata();
  for (const [index, nodes] of texts.entries()) {
    if (index > 0) children.push(pmNodeToYElement(atoms[index - 1], meta));
    if (nodes.length === 0) continue;
    if (index === 0 && previous) insertInto(previous.child, previous.length, nodes);
    else if (index === texts.length - 1 && next) insertInto(next.child, 0, nodes);
    else children.push(textNodesToYText(nodes));
  }
  leaf.insert(
    slots.filter((slot) => slot !== next && slot.start + slot.length <= at).length,
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
  const inserted = parsed.blocks.map((block) =>
    pmNodeToYElement(withBlockIds(block), createBindingMetadata()),
  );
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

function collectTextSegments(block: Y.XmlElement): TextSegment[] {
  const segments: TextSegment[] = [];
  let offset = 0;
  const visit = (type: Y.XmlElement | Y.XmlText) => {
    if (type instanceof Y.XmlText) {
      const length = type.length;
      segments.push({ text: type, start: offset, length });
      offset += length;
      return;
    }
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(block);
  return segments;
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

function attributesAtFlatOffset(
  segments: readonly TextSegment[],
  flatOffset: number,
): Record<string, unknown> | undefined {
  for (const segment of segments) {
    if (flatOffset >= segment.start && flatOffset <= segment.start + segment.length) {
      return attributesAt(segment.text, flatOffset - segment.start);
    }
  }
  return undefined;
}

function attributesAt(text: Y.XmlText, offset: number): Record<string, unknown> | undefined {
  let cursor = 0;
  let previous: Record<string, unknown> | undefined;
  for (const delta of text.toDelta() as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 0;
    const attrs = delta.attributes;
    if (offset >= cursor && offset < cursor + length) return attrs;
    if (offset === cursor + length) previous = attrs;
    cursor += length;
  }
  return previous;
}

function insertionPoint(
  block: Y.XmlElement,
  segments: readonly TextSegment[],
  flatOffset: number,
): { text: Y.XmlText; offset: number } {
  for (const segment of segments) {
    if (flatOffset >= segment.start && flatOffset <= segment.start + segment.length) {
      return { text: segment.text, offset: flatOffset - segment.start };
    }
  }
  const text = new Y.XmlText();
  block.insert(0, [text]);
  return { text, offset: 0 };
}

function pmNodeToYElement(node: PMNode, meta: BindingMetadata): Y.XmlElement {
  const element = new Y.XmlElement(node.type.name);
  for (const key of Object.keys(node.attrs)) {
    const value = node.attrs[key];
    if (value !== null && key !== "ychange") element.setAttribute(key, value);
  }
  const children = normalizeContent(node).map((child) =>
    Array.isArray(child) ? textNodesToYText(child) : pmNodeToYElement(child, meta),
  );
  if (children.length > 0) element.insert(0, children);
  meta.mapping.set(element, node);
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

function createBindingMetadata(): BindingMetadata {
  return { mapping: new Map(), isOMark: new Map() };
}
