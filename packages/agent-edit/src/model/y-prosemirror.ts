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
  InlineReplacementResult,
  InlineTextReplacement,
  MinimalOp,
  ProjectedBlock,
  RoomNodeState,
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

    applyInlineReplacements(doc, block, replacements) {
      return applyInlineReplacements(unwrapDoc(doc), unwrapBlock(block), replacements, schema);
    },

    applyBlockReplacement(doc, block, replacement) {
      applyBlockDiff(unwrapDoc(doc), unwrapBlock(block), replacement);
    },

    removedUnits(block, current) {
      return removedUnits(unwrapBlock(block), unwrapDoc(current));
    },

    removedLeafUnits(block, path, current) {
      return removedLeafUnits(nodeAt(unwrapBlock(block), path), unwrapDoc(current));
    },

    roomNodeState(block, path, current) {
      return roomNodeState(nodeAt(unwrapBlock(block), path), unwrapDoc(current));
    },

    applyMinimalOps(_doc, block, ops) {
      applyMinimalOps(unwrapBlock(block), ops);
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

export function applyInlineReplacements(
  doc: Y.Doc,
  block: Y.XmlElement | BlockRef,
  replacements: readonly InlineTextReplacement[],
  schema: Schema,
): InlineReplacementResult {
  const element = unwrapBlock(toRef(block));
  const current = projectBlocks(doc, schema).find(
    (block) => unwrapBlock(block.ref) === element,
  )?.node;
  if (!current) throw new Error("Y.XmlElement is not a top-level block in this document");
  const blockType = element.nodeName;
  if (current.type.name !== blockType) return blockTypeMismatch(blockType, current.type.name);
  if (!canReplaceInline(current) || !hasFlatInlineContent(current)) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Text edits require flat inline content in ${current.type.name} blocks`,
    };
  }

  if (element.length === 0 && current.content.size === 0) element.insert(0, [new Y.XmlText()]);
  const text = element.get(0);
  if (!(text instanceof Y.XmlText) || element.length !== 1) {
    return { ok: false, code: "invalid_write", message: "Text edits require one flat Y.XmlText" };
  }
  for (const replacement of [...replacements].reverse()) {
    const { from, to } = replacement.span;
    if (to > from) text.delete(from, to - from);
    let offset = from;
    replacement.content.forEach((node) => {
      if (!node.isText) throw new Error("Exact text replacement requires text nodes");
      const attributes = Object.fromEntries(node.marks.map((mark) => [mark.type.name, mark.attrs]));
      text.insert(offset, node.text ?? "", attributes);
      offset += node.text?.length ?? 0;
    });
  }
  return { ok: true };
}

function canReplaceInline(block: PMNode): boolean {
  return block.isTextblock && block.type.name !== "code_block";
}

function hasFlatInlineContent(block: PMNode): boolean {
  return block.content.size === block.textContent.length;
}

function blockTypeMismatch(
  actual: string,
  expected: string,
): { ok: false; code: "not_found"; message: string; details: Record<string, unknown> } {
  return {
    ok: false,
    code: "not_found",
    message: `Block type changed from ${actual} to ${expected}; re-read before writing`,
    details: { actual, expected },
  };
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

/**
 * The flat text block's character runs whose items `current` holds deleted, in document
 * order. A clock `current` keeps no item for was collected, so it counts as deleted too.
 */
function removedUnits(block: Y.XmlElement, current: Y.Doc): Span[] {
  const runs: Span[] = [];
  let offset = 0;
  for (const text of block.toArray()) {
    if (!(text instanceof Y.XmlText)) continue;
    const textItem = text._item && findItem(current, text._item.id);
    if (!textItem || textItem.deleted) {
      runs.push({ from: offset, to: offset + text.length });
      offset += text.length;
      continue;
    }
    for (let item = text._start; item; item = item.right) {
      if (item.deleted || !item.countable) continue;
      const { client, clock } = item.id;
      let cursor = clock;
      for (const live of itemsInRange(current, { client, clock, len: item.length })) {
        if (live.item.deleted) continue;
        if (live.clock > cursor)
          runs.push({ from: offset + cursor - clock, to: offset + live.clock - clock });
        cursor = live.clock + live.len;
      }
      if (cursor < clock + item.length)
        runs.push({ from: offset + cursor - clock, to: offset + item.length });
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

// ─── SPIKE: minimal operations ──────────────────────────────────────

function nodeAt(block: Y.XmlElement, path: readonly number[]): Y.XmlElement {
  let node = block;
  for (const index of path) {
    const child = node.get(index);
    if (!(child instanceof Y.XmlElement)) throw new Error("Path does not address an element");
    node = child;
  }
  return node;
}

function deletedInRoom(item: Y.Item | null, current: Y.Doc): boolean {
  for (let at = item; at; at = (at.parent as Y.AbstractType<unknown>)._item) {
    const live = findItem(current, at.id);
    if (!live || live.deleted) return true;
  }
  return false;
}

/**
 * `removedUnits` for a text leaf at any depth. A unit is a text character or an inline atom,
 * so offsets are the leaf node's ProseMirror content offsets.
 */
function removedLeafUnits(leaf: Y.XmlElement, current: Y.Doc): Span[] {
  const size = leaf
    .toArray()
    .reduce((sum, child) => sum + (child instanceof Y.XmlText ? child.length : 1), 0);
  if (deletedInRoom(leaf._item, current)) return size > 0 ? [{ from: 0, to: size }] : [];
  const runs: Span[] = [];
  const push = (from: number, to: number) => {
    const last = runs.at(-1);
    if (last && last.to === from) last.to = to;
    else runs.push({ from, to });
  };
  let offset = 0;
  for (const child of leaf.toArray()) {
    if (!(child instanceof Y.XmlText)) {
      const item = (child as Y.XmlElement)._item;
      if (deletedInRoom(item, current)) push(offset, offset + 1);
      offset += 1;
      continue;
    }
    const textItem = child._item && findItem(current, child._item.id);
    if (!textItem || textItem.deleted) {
      if (child.length > 0) push(offset, offset + child.length);
      offset += child.length;
      continue;
    }
    for (let item = child._start; item; item = item.right) {
      if (item.deleted || !item.countable) continue;
      const { client, clock } = item.id;
      let cursor = clock;
      for (const live of itemsInRange(current, { client, clock, len: item.length })) {
        if (live.item.deleted) continue;
        if (live.clock > cursor) push(offset + cursor - clock, offset + live.clock - clock);
        cursor = live.clock + live.len;
      }
      if (cursor < clock + item.length) push(offset + cursor - clock, offset + item.length);
      offset += item.length;
    }
  }
  return runs;
}

function roomNodeState(node: Y.XmlElement, current: Y.Doc): RoomNodeState {
  if (deletedInRoom(node._item, current)) return { removed: true, changedAttrs: [] };
  const item = node._item && findItem(current, node._item.id);
  const live = item?.content instanceof Y.ContentType ? item.content.type : null;
  if (!(live instanceof Y.XmlElement)) return { removed: true, changedAttrs: [] };
  const mine = node.getAttributes() as Record<string, unknown>;
  const theirs = live.getAttributes() as Record<string, unknown>;
  const changedAttrs = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].filter(
    (key) => JSON.stringify(mine[key] ?? null) !== JSON.stringify(theirs[key] ?? null),
  );
  return { removed: false, changedAttrs };
}

/**
 * Every address is resolved to its Yjs type before anything changes, so an operation's
 * path and offsets mean the block as planned whatever ran before it.
 */
function applyMinimalOps(block: Y.XmlElement, ops: readonly MinimalOp[]): void {
  const resolved = ops.map((op) => {
    if (op.kind === "insert") {
      const parent = nodeAt(block, op.path);
      const after = op.after < 0 ? null : parent.get(op.after);
      return { op, parent, after };
    }
    return { op, node: nodeAt(block, op.path) };
  });
  for (const entry of resolved) {
    const { op } = entry;
    if (op.kind === "text") applyLeafEdit(entry.node as Y.XmlElement, op);
    else if (op.kind === "attrs") {
      for (const [key, value] of Object.entries(op.attrs)) {
        if (value === null || value === undefined)
          (entry.node as Y.XmlElement).removeAttribute(key);
        else (entry.node as Y.XmlElement).setAttribute(key, value as string);
      }
    } else if (op.kind === "insert") {
      const parent = entry.parent as Y.XmlElement;
      const index = entry.after ? parent.toArray().indexOf(entry.after as Y.XmlElement) + 1 : 0;
      parent.insert(
        index,
        op.nodes.map((node) => pmNodeToYElement(node, createBindingMetadata())),
      );
    } else {
      const node = entry.node as Y.XmlElement;
      const parent = node.parent as Y.XmlElement;
      const index = parent.toArray().indexOf(node);
      if (index >= 0) parent.delete(index, 1);
    }
  }
}

function applyLeafEdit(leaf: Y.XmlElement, op: Extract<MinimalOp, { kind: "text" }>): void {
  if (leaf.length === 0) leaf.insert(0, [new Y.XmlText()]);
  const parts = () => {
    let start = 0;
    return leaf.toArray().map((child, index) => {
      const length = child instanceof Y.XmlText ? child.length : 1;
      const part = { child, index, start, length };
      start += length;
      return part;
    });
  };
  // Formats run first: they don't move offsets, and they never cover a splice.
  for (const format of op.formats) {
    for (const part of parts()) {
      if (!(part.child instanceof Y.XmlText)) continue;
      const from = Math.max(format.from, part.start);
      const to = Math.min(format.to, part.start + part.length);
      if (from < to)
        part.child.format(from - part.start, to - from, { [format.mark]: format.attrs });
    }
  }
  for (const splice of [...op.splices].reverse()) {
    for (const part of parts().reverse()) {
      const from = Math.max(splice.from, part.start);
      const to = Math.min(splice.to, part.start + part.length);
      if (from >= to) continue;
      if (part.child instanceof Y.XmlText) part.child.delete(from - part.start, to - from);
      else leaf.delete(part.index, 1);
    }
    if (splice.content.size === 0) continue;
    // Deletes above leave every unit before `from` where it was.
    const before = parts();
    let target: (typeof before)[number] | undefined;
    for (const part of before)
      if (
        part.child instanceof Y.XmlText &&
        splice.from >= part.start &&
        splice.from <= part.start + part.length
      )
        target = part;
    if (!target) {
      const index = before.findIndex((part) => part.start >= splice.from);
      const text = new Y.XmlText();
      leaf.insert(index < 0 ? leaf.length : index, [text]);
      target = { child: text, index: 0, start: splice.from, length: 0 };
    }
    // Prefer the text that ends at the splice: an insert after a match stays with the match.
    const ending = before.find(
      (part) => part.child instanceof Y.XmlText && part.start + part.length === splice.from,
    );
    if (ending && ending.length > 0) target = ending;
    const groups = normalizeContent({
      childCount: splice.content.childCount,
      child: (i: number) => splice.content.child(i),
    } as unknown as PMNode);
    const lead = Array.isArray(groups[0]) ? (groups.shift() as PMNode[]) : [];
    const insertText = (text: Y.XmlText, at: number, nodes: readonly PMNode[]) => {
      let offset = at;
      for (const node of nodes) {
        const attributes = Object.fromEntries(
          node.marks.map((mark) => [mark.type.name, mark.attrs]),
        );
        text.insert(offset, node.text ?? "", attributes);
        offset += node.text?.length ?? 0;
      }
    };
    if (groups.length === 0) {
      insertText(target.child as Y.XmlText, splice.from - target.start, lead);
      continue;
    }
    // An inline atom is a child of the leaf, so it can only go between two text runs.
    const left = before.find(
      (part) => part.child instanceof Y.XmlText && part.start + part.length === splice.from,
    );
    const right = before.find(
      (part) => part.child instanceof Y.XmlText && part.start === splice.from && part !== left,
    );
    if (!left && !right && target.length > 0 && splice.from > target.start)
      throw new Error("SPIKE: an inline atom inside a text run needs the run split");
    const tail = Array.isArray(groups.at(-1)) ? (groups.pop() as PMNode[]) : [];
    if (lead.length > 0 && left) insertText(left.child as Y.XmlText, left.length, lead);
    else if (lead.length > 0) groups.unshift(lead);
    if (tail.length > 0 && right) insertText(right.child as Y.XmlText, 0, tail);
    else if (tail.length > 0) groups.push(tail);
    const index = left
      ? left.index + 1
      : right
        ? right.index
        : before.filter((part) => part.start + part.length <= splice.from).length;
    leaf.insert(
      index,
      groups.map((group) =>
        Array.isArray(group)
          ? textNodesToYText(group)
          : pmNodeToYElement(group, createBindingMetadata()),
      ),
    );
  }
}
