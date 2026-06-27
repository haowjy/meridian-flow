import type { ParsedContent } from "@meridian/markup";
import type { Mark, Node as PMNode, Schema } from "prosemirror-model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block, Span } from "../codec-types.js";
import type { BlockRef } from "../handles.js";
import { toRef, unwrapBlock, unwrapDoc } from "../handles.js";
import type { AgentEditModel, InlineReplacementResult, TextRun } from "../ports/model.js";
import {
  blockHashesForDoc,
  getBlockHash,
  getTopLevelXmlBlocks,
  isLiveXmlElement,
  lookupBlockHash,
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

    getDocumentBlockIds(doc) {
      return blockHashesForDoc(unwrapDoc(doc));
    },

    lookupBlock(doc, hash) {
      const lookup = lookupBlockHash(unwrapDoc(doc), hash);
      if (!lookup.ok) return { ok: false, reason: lookup.reason };
      return { ok: true, block: toRef(lookup.block) };
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

    inlineRuns(block) {
      return collectTextRuns(unwrapBlock(block));
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

    stateVectorAdvanced(beforeVector, afterVector) {
      return stateVectorAdvanced(beforeVector, afterVector);
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

    isPlainTextReplacement(parsed, source) {
      return isPlainTextReplacement(parsed, source);
    },

    applyInlineReplacement(doc, block, span, replacementMarkup, codec) {
      return applyInlineReplacement(
        unwrapDoc(doc),
        unwrapBlock(block),
        span,
        replacementMarkup,
        codec,
        schema,
      );
    },

    projectBlocks(doc) {
      return prosemirrorBlocksForDoc(unwrapDoc(doc), schema);
    },

    serializeBlockLines(doc, codec, blocks) {
      return serializeBlockLines(unwrapDoc(doc), codec, schema, blocks);
    },

    serializeBlockBodies(doc, codec, blocks) {
      return serializeBlockBodies(unwrapDoc(doc), codec, schema, blocks);
    },
  };
}

export function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
}

export function prosemirrorRootOf(doc: Y.Doc, schema: Schema): PMNode {
  return yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), schema);
}

export function toProsemirrorBlock(
  doc: Y.Doc,
  block: Y.XmlElement | BlockRef,
  schema: Schema,
): PMNode {
  const element = unwrapBlock(toRef(block));
  const blocks = getTopLevelXmlBlocks(doc);
  const index = blocks.indexOf(element);
  if (index < 0) throw new Error("Y.XmlElement is not a top-level block in this document");
  const pmBlock = prosemirrorRootOf(doc, schema).child(index);
  if (!pmBlock) throw new Error("ProseMirror block not found for Y.XmlElement");
  return pmBlock;
}

/** Project the PM tree once and return all top-level block nodes — O(D), not O(B·D). */
export function prosemirrorBlocksForDoc(doc: Y.Doc, schema: Schema): PMNode[] {
  const root = prosemirrorRootOf(doc, schema);
  const blocks: PMNode[] = [];
  for (let i = 0; i < root.childCount; i++) {
    blocks.push(root.child(i));
  }
  return blocks;
}

function stateVectorAdvanced(beforeVector: Uint8Array, afterVector: Uint8Array): boolean {
  const before = Y.decodeStateVector(beforeVector);
  const after = Y.decodeStateVector(afterVector);
  for (const [client, clock] of after) {
    if (clock > (before.get(client) ?? 0)) return true;
  }
  return false;
}

export function applyTextEdit(block: Y.XmlElement | BlockRef, span: Span, newText: string): void {
  block = unwrapBlock(toRef(block));
  const text = collectText(block);
  if (span.from < 0 || span.to < span.from || span.to > text.length) {
    throw new RangeError(
      `Invalid text span ${span.from}..${span.to} for block length ${text.length}`,
    );
  }

  const segments = collectTextSegments(block);
  const insertAttrs = attributesAtFlatOffset(segments, span.from);

  for (const segment of [...segments].reverse()) {
    const from = Math.max(span.from, segment.start);
    const to = Math.min(span.to, segment.start + segment.length);
    if (from < to) segment.text.delete(from - segment.start, to - from);
  }

  if (newText.length === 0) return;
  const insertion = insertionPoint(block, segments, span.from);
  insertion.text.insert(insertion.offset, newText, insertAttrs);
}

export function applyBlockDiff(
  doc: Y.Doc,
  block: Y.XmlElement | BlockRef,
  replacement: PMNode,
): void {
  block = unwrapBlock(toRef(block));
  if (block.nodeName !== replacement.type.name) {
    throw new Error(`Cannot update ${block.nodeName} block with ${replacement.type.name} content`);
  }
  updateYFragment(doc, block as unknown as Y.XmlFragment, replacement, createBindingMetadata());
}

export function applyInlineReplacement(
  doc: Y.Doc,
  block: Y.XmlElement | BlockRef,
  span: Span,
  replacementMarkup: string,
  codec: AgentEditCodec,
  schema: Schema,
): InlineReplacementResult {
  const element = unwrapBlock(toRef(block));
  const current = toProsemirrorBlock(doc, element, schema);
  const blockType = element.nodeName;
  if (current.type.name !== blockType) {
    return blockTypeMismatch(blockType, current.type.name);
  }

  let parsed: ParsedContent;
  try {
    parsed = replacementMarkup.length === 0 ? { blocks: [] } : codec.parse(replacementMarkup);
  } catch (cause) {
    return parseFailure(cause);
  }

  const inline = inlineReplacement(parsed);
  if (!inline.ok) return inline;
  if (!canReplaceInline(current)) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Text edits with formatting are not supported for ${current.type.name} blocks`,
    };
  }
  const replacement = replaceFlatText(current, span, inline.nodes);
  if (replacement.type.name !== blockType) {
    return blockTypeMismatch(blockType, replacement.type.name);
  }
  applyBlockDiff(doc, element, replacement);
  return { ok: true };
}

function isPlainTextReplacement(parsed: ParsedContent, source: string): boolean {
  if (source.length === 0) return true;
  if (parsed.blocks.length !== 1) return false;
  const block = parsed.blocks[0];
  if (!block?.isTextblock) return false;
  if (block.textContent !== source) return false;
  let plain = true;
  block.descendants((node) => {
    if (node.isText) {
      if (node.marks.length > 0) plain = false;
      return false;
    }
    if (node.type.name !== "hard_break") plain = false;
    return !plain;
  });
  return plain;
}

function inlineReplacement(
  parsed: ParsedContent,
): { ok: true; nodes: Block[] } | { ok: false; code: "invalid_write"; message: string } {
  if (parsed.blocks.length === 0) return { ok: true, nodes: [] };
  if (parsed.blocks.length !== 1) {
    return {
      ok: false,
      code: "invalid_write",
      message: "Text edits cannot introduce multiple blocks; use an insert/delete structural edit",
    };
  }
  const block = parsed.blocks[0];
  if (!block?.isTextblock) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Text edit content must parse to inline text, got ${block?.type.name ?? "nothing"}`,
    };
  }
  const nodes: Block[] = [];
  block.forEach((child) => {
    nodes.push(child);
  });
  return { ok: true, nodes };
}

function canReplaceInline(block: PMNode): boolean {
  return block.isTextblock && block.type.name !== "code_block";
}

function replaceFlatText(block: PMNode, span: Span, replacement: readonly PMNode[]): PMNode {
  let cursor = 0;
  let inserted = false;
  const children: PMNode[] = [];

  const insertReplacement = () => {
    if (inserted) return;
    children.push(...replacement);
    inserted = true;
  };

  block.forEach((child) => {
    if (!child.isText) {
      if (cursor >= span.from && cursor <= span.to) insertReplacement();
      children.push(child);
      return;
    }
    const text = child.text ?? "";
    const start = cursor;
    const end = cursor + text.length;
    if (end <= span.from || start >= span.to) {
      if (!inserted && span.from === span.to && span.from === start) insertReplacement();
      children.push(child);
      cursor = end;
      return;
    }

    const keepLeft = Math.max(0, span.from - start);
    const keepRight = Math.max(0, end - span.to);
    if (keepLeft > 0) children.push(child.type.schema.text(text.slice(0, keepLeft), child.marks));
    insertReplacement();
    if (keepRight > 0) {
      children.push(child.type.schema.text(text.slice(text.length - keepRight), child.marks));
    }
    cursor = end;
  });
  if (!inserted) insertReplacement();

  return block.type.create(block.attrs, children, block.marks);
}

function serializeBlockLines(
  doc: Y.Doc,
  codec: AgentEditCodec,
  schema: Schema,
  selectedBlocks?: readonly BlockRef[],
): string[] {
  const blocks = getTopLevelXmlBlocks(doc).map(toRef);
  if (blocks.length === 0) return [];
  const hashes = blockHashesForDoc(doc);
  const pmBlocks = prosemirrorBlocksForDoc(doc, schema);
  if (!selectedBlocks) return codec.serializeBlocks(pmBlocks, hashes);
  const indexByBlock = new Map<BlockRef, number>();
  blocks.forEach((block, index) => {
    indexByBlock.set(block, index);
  });
  const selectedPmBlocks: PMNode[] = [];
  const selectedHashes: string[] = [];
  for (const block of selectedBlocks) {
    const index = indexByBlock.get(block);
    if (index === undefined) continue;
    selectedPmBlocks.push(pmBlocks[index]);
    selectedHashes.push(hashes[index]);
  }
  return codec.serializeBlocks(selectedPmBlocks, selectedHashes);
}

function serializeBlockBodies(
  doc: Y.Doc,
  codec: AgentEditCodec,
  schema: Schema,
  selectedBlocks: readonly BlockRef[],
): string[] {
  const blocks = getTopLevelXmlBlocks(doc).map(toRef);
  const pmBlocks = prosemirrorBlocksForDoc(doc, schema);
  const indexByBlock = new Map<BlockRef, number>();
  blocks.forEach((block, index) => {
    indexByBlock.set(block, index);
  });
  const selectedPmBlocks: PMNode[] = [];
  for (const block of selectedBlocks) {
    const index = indexByBlock.get(block);
    if (index !== undefined) selectedPmBlocks.push(pmBlocks[index]);
  }
  return codec.serializeBlockBodies(selectedPmBlocks);
}

function parseFailure(cause: unknown): InlineReplacementResult {
  const record = cause instanceof Error ? cause : undefined;
  const details: Record<string, unknown> = {};
  const line = (cause as { line?: unknown } | null)?.line;
  const column = (cause as { column?: unknown } | null)?.column;
  if (typeof line === "number") details.line = line;
  if (typeof column === "number") details.column = column;
  return {
    ok: false,
    code: "invalid_write",
    message: record?.message ?? String(cause),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
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

function collectTextRuns(block: Y.XmlElement): TextRun[] {
  const runs: TextRun[] = [];
  let flatOffset = 0;
  const visit = (type: Y.XmlElement | Y.XmlText) => {
    if (type instanceof Y.XmlText) {
      for (const delta of type.toDelta() as Array<{
        insert?: string;
        attributes?: Record<string, unknown>;
      }>) {
        const text = typeof delta.insert === "string" ? delta.insert : "";
        const length = text.length;
        if (length > 0) {
          runs.push({
            start: flatOffset,
            length,
            attrsKey: stableAttrsKey(delta.attributes),
          });
          flatOffset += length;
        }
      }
      return;
    }
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(block);
  return runs;
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

function stableAttrsKey(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return "";
  return JSON.stringify(sortRecord(attrs));
}

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecord);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortRecord(nested)]),
  );
}

function createBindingMetadata(): BindingMetadata {
  return { mapping: new Map(), isOMark: new Map() };
}
