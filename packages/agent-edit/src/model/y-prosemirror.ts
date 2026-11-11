import type { ParsedContent } from "@meridian/markup";
import type { Mark, Node as PMNode, Schema } from "prosemirror-model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
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
import { findItem, itemsInRange } from "../yjs-mutation.js";
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
      return element.nodeName === "heading"
        ? Number(element.getAttribute("level") ?? 1)
        : undefined;
    },

    getText(block) {
      return collectText(unwrapBlock(block));
    },

    getVisibleContentLineage(block) {
      return collectVisibleContentLineage(unwrapBlock(block));
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

    roomTextblock(block, path, current) {
      return roomTextblock(nodeAt(unwrapBlock(block), path), unwrapDoc(current));
    },

    roomNodeRemoved(block, path, current) {
      return deletedInRoom(nodeAt(unwrapBlock(block), path)._item, unwrapDoc(current));
    },

    projectBlocks(doc) {
      return projectBlocks(unwrapDoc(doc), schema);
    },
  };
}

export function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
}

export function prosemirrorRootOf(doc: Y.Doc, schema: Schema): PMNode {
  return yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), schema);
}

/**
 * One walk that pairs each top-level element with its node. Building the root repairs the
 * document (an element the schema can't build is deleted and dropped), so the surviving
 * elements are read after it and are exactly the ones that produced nodes; hashes are
 * computed over them, never over the pre-repair list.
 */
function projectBlocks(doc: Y.Doc, schema: Schema): ProjectedBlock[] {
  const root = prosemirrorRootOf(doc, schema);
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
    node: root.child(index),
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
  writePmBlock(doc, element, replacement);
}

function writePmBlock(doc: Y.Doc, block: Y.XmlElement, replacement: PMNode): void {
  updateYFragment(doc, block as unknown as Y.XmlFragment, replacement, createBindingMetadata());
}

/**
 * Every path and offset is checked before anything changes, so an operation means the
 * block as planned whatever ran before it, and a write that does not fit leaves it alone.
 */
function applyOps(block: Y.XmlElement, ops: readonly EditOp[]): EditOpsResult {
  const nodes: Y.XmlElement[] = [];
  for (const op of ops) {
    const node = findNode(block, op.path);
    const problem = node ? opProblem(node, op) : "its path does not address an element";
    if (!node || problem) return invalidOp(`Cannot apply a ${op.kind} operation: ${problem}`);
    nodes.push(node);
  }
  for (const [index, op] of ops.entries()) {
    if (op.kind === "text") applyTextOp(nodes[index], op);
    else
      for (const [key, value] of Object.entries(op.attrs)) {
        if (value === null || value === undefined) nodes[index].removeAttribute(key);
        else nodes[index].setAttribute(key, value as string);
      }
  }
  return { ok: true };
}

function invalidOp(message: string): EditOpsResult {
  return { ok: false, code: "invalid_write", message };
}

/** Why `op` cannot be applied to `node`, if it cannot. */
function opProblem(node: Y.XmlElement, op: EditOp): string | undefined {
  if (op.kind === "attrs") return undefined;
  const children = node.toArray();
  if (node.nodeName === "code_block" || !children.every(isXmlText))
    return "text edits require flat text";
  const size = children.reduce((sum, run) => sum + (run as Y.XmlText).length, 0);
  let cursor = 0;
  for (const { from, to, content } of op.splices) {
    if (from < cursor || to < from || to > size) return `invalid splice ${from}..${to} of ${size}`;
    let inline = true;
    content.forEach((child) => {
      inline &&= child.isText;
    });
    if (!inline) return "spliced content must be text";
    cursor = to;
  }
  for (const { from, to } of op.formats)
    if (from < 0 || to <= from || to > size)
      return `invalid format range ${from}..${to} of ${size}`;
  return undefined;
}

function isXmlText(child: unknown): child is Y.XmlText {
  return child instanceof Y.XmlText;
}

/** Units are addressed across the element's consecutive text runs, as `roomTextblock` reads them. */
function applyTextOp(leaf: Y.XmlElement, op: Extract<EditOp, { kind: "text" }>): void {
  if (leaf.length === 0) leaf.insert(0, [new Y.XmlText()]);
  const runs: Array<{ text: Y.XmlText; start: number }> = [];
  let start = 0;
  for (const child of leaf.toArray() as Y.XmlText[]) {
    runs.push({ text: child, start });
    start += child.length;
  }
  // Formats don't move offsets, so they go first.
  for (const { from, to, mark, attrs } of op.formats)
    for (const run of runs) {
      const lo = Math.max(from, run.start);
      const hi = Math.min(to, run.start + run.text.length);
      if (lo < hi) run.text.format(lo - run.start, hi - lo, { [mark]: attrs });
    }
  // Right to left, so earlier offsets stay where they were planned. Each splice deletes, then
  // inserts after its deleted units, as the editor's binding places a replacement.
  for (const { from, to, content } of [...op.splices].reverse()) {
    for (const run of [...runs].reverse()) {
      const lo = Math.max(from, run.start);
      const hi = Math.min(to, run.start + run.text.length);
      if (lo < hi) run.text.delete(lo - run.start, hi - lo);
    }
    // The first run that reaches the offset, so an insert at a boundary joins the earlier run.
    const target = runs.find((run) => from <= run.start + run.text.length) ?? runs[runs.length - 1];
    let offset = from - target.start;
    content.forEach((node) => {
      const attributes = Object.fromEntries(node.marks.map((mark) => [mark.type.name, mark.attrs]));
      target.text.insert(offset, node.text ?? "", attributes);
      offset += node.text?.length ?? 0;
    });
  }
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
  const inserted = parsed.blocks.map((block) => pmNodeToYElement(block, createBindingMetadata()));
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

/** Whether `current` holds the item deleted, or an item above it; one it keeps none for counts too. */
function deletedInRoom(item: Y.Item | null, current: Y.Doc): boolean {
  for (let at = item; at; at = (at.parent as Y.AbstractType<unknown>)._item) {
    const live = findItem(current, at.id);
    if (!live || live.deleted) return true;
  }
  return false;
}

/**
 * The textblock's units that `current` has deleted, in order. A unit is a text character or
 * an inline atom. A clock `current` keeps no item for was collected, so it counts as deleted.
 */
function roomTextblock(leaf: Y.XmlElement, current: Y.Doc): Span[] {
  const runs: Span[] = [];
  const remove = (from: number, to: number) => {
    const last = runs.at(-1);
    if (last && last.to === from) last.to = to;
    else runs.push({ from, to });
  };
  let offset = 0;
  for (const child of leaf.toArray()) {
    if (!(child instanceof Y.XmlText)) {
      if (deletedInRoom(child._item, current)) remove(offset, offset + 1);
      offset += 1;
      continue;
    }
    if (deletedInRoom(child._item, current)) {
      if (child.length > 0) remove(offset, offset + child.length);
      offset += child.length;
      continue;
    }
    for (let item = child._start; item; item = item.right) {
      if (item.deleted || !item.countable) continue;
      const { client, clock } = item.id;
      let cursor = clock;
      for (const live of itemsInRange(current, { client, clock, len: item.length })) {
        if (live.item.deleted) continue;
        if (live.clock > cursor) remove(offset + cursor - clock, offset + live.clock - clock);
        cursor = live.clock + live.len;
      }
      if (cursor < clock + item.length) remove(offset + cursor - clock, offset + item.length);
      offset += item.length;
    }
  }
  return runs;
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
