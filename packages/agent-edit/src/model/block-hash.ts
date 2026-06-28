import * as Y from "yjs";
import type { BlockRef } from "../handles.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "../model/prosemirror-fragment.js";

const DEFAULT_HASH_LENGTH = 4;
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const HEX_FIELD_WIDTH = 16;

interface YItemId {
  client: number;
  clock: number;
}

interface YItemLike {
  id: YItemId;
  deleted: boolean;
  parent: unknown;
}

type IntegratedXmlElement = Y.XmlElement & { _item: YItemLike | null; doc: Y.Doc | null };

export interface BlockItemId {
  clientID: number;
  clock: number;
}

export type BlockHashLookup =
  | { ok: true; hash: string; block: Y.XmlElement }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: Y.XmlElement[] };

/** Top-level y-prosemirror blocks from the shared ProseMirror XmlFragment. */
export function getTopLevelXmlBlocks(doc: Y.Doc): Y.XmlElement[] {
  return doc
    .getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)
    .toArray()
    .filter((value): value is Y.XmlElement => value instanceof Y.XmlElement);
}

/** Immutable CRDT item ID assigned by Yjs when the block element is created. */
export function getBlockItemId(block: Y.XmlElement | BlockRef): BlockItemId {
  const item = itemFor(block);
  return { clientID: item.id.client, clock: item.id.clock };
}

/** Stable block hash, unique among currently live sibling blocks. */
export function getBlockHash(block: Y.XmlElement | BlockRef): string {
  const siblings = siblingBlocks(block);
  const element = block as unknown as Y.XmlElement;
  return uniqueHashFor(element, siblings.length > 0 ? siblings : [element]);
}

/** Compute hashes for all top-level blocks in one pass — O(B log B), not O(B² log B). */
export function blockHashesForDoc(doc: Y.Doc): string[] {
  const blocks = getTopLevelXmlBlocks(doc);
  return uniqueHashesForBlocks(blocks);
}

/** Deterministic full hash material for a CRDT item ID. Prefixes are displayed to agents. */
export function fullHashForItemId(id: BlockItemId): string {
  const key = `${id.clientID}:${id.clock}`;
  return `${fnv1a64Hex(key)}${fixedHex(id.clientID)}${fixedHex(id.clock)}`;
}

/** Reverse lookup from an agent-visible hash to a live block in this local Y.Doc. */
export function lookupBlockHash(doc: Y.Doc, hash: string): BlockHashLookup {
  const normalized = hash.trim().toLowerCase();
  if (normalized.length === 0) return { ok: false, reason: "not_found" };

  const matches: Y.XmlElement[] = [];
  for (const block of getTopLevelXmlBlocks(doc)) {
    const fullHash = fullHashForItemId(getBlockItemId(block));
    // Display hashes are flexible prefixes; resolve held old widths against immutable full hashes.
    if (fullHash.startsWith(normalized)) matches.push(block);
  }
  if (matches.length === 1) return { ok: true, hash: normalized, block: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: false, reason: "not_found" };
}

export function isLiveXmlElement(block: Y.XmlElement | BlockRef): boolean {
  const integrated = block as IntegratedXmlElement;
  return integrated._item !== null && !integrated._item.deleted;
}

function uniqueHashFor(target: Y.XmlElement, blocks: readonly Y.XmlElement[]): string {
  const hashes = uniqueHashesForBlocks(blocks);
  const index = blocks.indexOf(target);
  if (index < 0) throw new Error("Target block was not present in its hash scope");
  return hashes[index];
}

/** Compute unique hashes for a set of blocks in one sorted pass. */
function uniqueHashesForBlocks(blocks: readonly Y.XmlElement[]): string[] {
  if (blocks.length === 0) return [];
  const indexed = blocks.map((block, i) => ({ block, i, id: getBlockItemId(block) }));
  indexed.sort((a, b) => a.id.clientID - b.id.clientID || a.id.clock - b.id.clock);
  const hashes: string[] = new Array(blocks.length);
  const used = new Set<string>();
  for (const entry of indexed) {
    const fullHash = fullHashForItemId(entry.id);
    let length = DEFAULT_HASH_LENGTH;
    let hash = fullHash.slice(0, length);
    while (used.has(hash) && length < fullHash.length) {
      length += 1;
      hash = fullHash.slice(0, length);
    }
    hashes[entry.i] = hash;
    used.add(hash);
  }
  return hashes;
}

function siblingBlocks(block: Y.XmlElement | BlockRef): Y.XmlElement[] {
  const item = itemFor(block);
  const parent = item.parent;
  if (parent instanceof Y.XmlFragment || parent instanceof Y.XmlElement) {
    return parent.toArray().filter((value): value is Y.XmlElement => value instanceof Y.XmlElement);
  }
  const doc = (block as unknown as IntegratedXmlElement).doc;
  return doc ? getTopLevelXmlBlocks(doc) : [];
}

function itemFor(block: Y.XmlElement | BlockRef): YItemLike {
  const item = (block as unknown as IntegratedXmlElement)._item;
  if (!item) {
    throw new Error(
      "Cannot derive a block hash before the Y.XmlElement is integrated into a Y.Doc",
    );
  }
  if (item.deleted) {
    throw new Error("Cannot derive a block hash for a deleted Y.XmlElement");
  }
  return item;
}

function fnv1a64Hex(input: string): string {
  let hash = FNV_64_OFFSET;
  for (const char of input) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * FNV_64_PRIME);
  }
  hash ^= hash >> 33n;
  hash = BigInt.asUintN(64, hash * 0xff51afd7ed558ccdn);
  hash ^= hash >> 33n;
  hash = BigInt.asUintN(64, hash * 0xc4ceb9fe1a85ec53n);
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(HEX_FIELD_WIDTH, "0");
}

function fixedHex(value: number): string {
  return BigInt(value).toString(16).padStart(HEX_FIELD_WIDTH, "0");
}
