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
  lookupBlockHash,
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
