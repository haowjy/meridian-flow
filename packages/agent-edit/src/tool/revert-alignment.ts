/** Identity-pinned inverse alignment and destination token evidence for forward revert planning. */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import type { Alignment } from "../diff/align.js";
import { readBlocks } from "../diff/fragments.js";
import { type Hunk, posMap } from "../diff/hunks.js";
import { buildSide, diffKeys, type Side, tokenizeBlock } from "../diff/tokens.js";
import type { LineageRange } from "../lineage/range-set.js";
import { equalOrderedMatches } from "../ordered-matching.js";
import type { EditRange } from "../undo/forward-inverse.js";

export interface TokenEvidence {
  touched: boolean;
  identity: string;
  /** Inline PM offsets (block-start and whole-block tokens have zero width). */
  from: number;
  to: number;
  /** One flag per UTF-16 inline unit, including leading whitespace. */
  changed: boolean[];
}

export interface IdentitySide {
  side: Side;
  evidence: WeakMap<PMNode, TokenEvidence[]>;
}

export function identitySide(
  doc: Y.Doc,
  schema: Schema,
  ranges: readonly EditRange[],
): IdentitySide {
  const fragment = doc.getXmlFragment("prosemirror");
  const blocks = readBlocks(fragment, schema);
  const evidence = new WeakMap<PMNode, TokenEvidence[]>();
  const byClient = new Map<number, EditRange[]>();
  for (const range of ranges) {
    const list = byClient.get(range.client) ?? [];
    list.push(range);
    byClient.set(range.client, list);
  }
  const touched = (range: LineageRange) =>
    byClient
      .get(range.clientID)
      ?.some(
        (other) =>
          other.clock < range.clock + range.length && range.clock < other.clock + other.len,
      ) ?? false;
  const rangeOf = (item: Y.Item): LineageRange => ({
    clientID: item.id.client,
    clock: item.id.clock,
    length: item.length,
  });
  const descendantsTouched = (type: Y.XmlElement | Y.XmlText): boolean => {
    if (type._item && touched(rangeOf(type._item))) return true;
    for (const item of type._map.values()) if (!item.deleted && touched(rangeOf(item))) return true;
    for (let item = type._start; item; item = item.right) {
      if (item.deleted) continue;
      if (touched(rangeOf(item))) return true;
      if (item.content instanceof Y.ContentType) {
        const child = item.content.type;
        if (
          (child instanceof Y.XmlElement || child instanceof Y.XmlText) &&
          descendantsTouched(child)
        )
          return true;
      }
    }
    return false;
  };

  const elements = fragment.toArray();
  blocks.forEach((block, index) => {
    const element = elements[index];
    if (!(element instanceof Y.XmlElement) || !element._item)
      throw new Error("Revert requires integrated top-level Yjs elements");
    const parent = rangeOf(element._item);
    const units: LineageRange[] = [];
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlText) {
        for (let item = child._start; item; item = item.right)
          if (!item.deleted && item.content instanceof Y.ContentString) units.push(rangeOf(item));
      } else if (child._item) {
        units.push({ ...rangeOf(child._item), length: 1 });
      }
    }
    let offset = 0;
    let unit = 0;
    let used = 0;
    const take = (length: number): LineageRange[] => {
      const result: LineageRange[] = [];
      while (length > 0) {
        const source = units[unit];
        if (!source) throw new Error("Revert tokenization disagrees with the Yjs inline stream");
        const count = Math.min(length, source.length - used);
        result.push({ ...source, clock: source.clock + used, length: count });
        length -= count;
        used += count;
        if (used === source.length) {
          unit++;
          used = 0;
        }
      }
      return result;
    };
    evidence.set(
      block,
      tokenizeBlock(block).map((token) => {
        const from = offset;
        const length =
          token.kind === "text"
            ? token.ws.length + token.core.length
            : token.kind === "inline"
              ? 1
              : 0;
        const whitespace = token.kind === "text" ? take(token.ws.length) : [];
        const ids =
          token.kind === "text"
            ? take(token.core.length)
            : token.kind === "inline"
              ? take(1)
              : [parent];
        const characters = [...whitespace, ...ids].flatMap((id) =>
          Array.from({ length: id.length }, (_, i) => ({ ...id, clock: id.clock + i, length: 1 })),
        );
        const core = ids.flatMap((id) =>
          Array.from({ length: id.length }, (_, i) => [id.clientID, id.clock + i]),
        );
        offset += length;
        return {
          from,
          to: offset,
          touched:
            token.kind === "atom"
              ? descendantsTouched(element)
              : touched(parent) || ids.some(touched),
          identity: JSON.stringify(core),
          changed: characters.map(touched),
        };
      }),
    );
  });
  return { side: buildSide(blocks), evidence };
}

export function tokenEvidence(side: Side, evidence: IdentitySide["evidence"]): TokenEvidence[] {
  return side.blocks.flatMap((node) => {
    const tokens = evidence.get(node);
    if (!tokens) throw new Error("Revert alignment lost an input node");
    return tokens;
  });
}

/** Matches only unchanged item runs, never an equal-looking copy inserted/deleted by N. */
export function inverseAligner(
  baseEvidence: IdentitySide["evidence"],
  draftEvidence: IdentitySide["evidence"],
): (base: Side, draft: Side) => Alignment {
  return (base, draft) => {
    const keys = (side: Side, evidence: IdentitySide["evidence"], name: string) =>
      tokenEvidence(side, evidence).map((token, index) =>
        token.touched ? `${name}:${index}` : token.identity,
      );
    const pairs = equalOrderedMatches(
      keys(base, baseEvidence, "base"),
      keys(draft, draftEvidence, "draft"),
    );
    return alignmentFromPairs(
      base,
      draft,
      pairs.filter(([a, b]) => base.toks[a].key === draft.toks[b].key),
    );
  };
}

/** No content-only paragraph anchors, memoized re-tokenization, cleanup or duplicate sliding. */
export function alignmentFromKeys(
  base: Side,
  side: Side,
  baseKeys: string[],
  sideKeys: string[],
): Alignment {
  const pairs: Array<readonly [number, number]> = [];
  let b = 0;
  let s = 0;
  for (const [operation, count] of diffKeys(baseKeys, sideKeys)) {
    if (operation === DIFF_EQUAL) for (let i = 0; i < count; i++) pairs.push([b + i, s + i]);
    if (operation !== DIFF_INSERT) b += count;
    if (operation !== DIFF_DELETE) s += count;
  }
  return alignmentFromPairs(base, side, pairs);
}

function alignmentFromPairs(
  base: Side,
  side: Side,
  pairs: Array<readonly [number, number]>,
): Alignment {
  const hunks: Hunk[] = [];
  let b = 0;
  let s = 0;
  for (const [nextB, nextS] of [...pairs, [base.toks.length, side.toks.length] as const]) {
    if (b !== nextB || s !== nextS)
      hunks.push({ from: b, to: nextB, sfrom: s, ins: side.toks.slice(s, nextS) });
    b = nextB + 1;
    s = nextS + 1;
  }
  const pos = posMap(base.toks.length, hunks);
  const baseToSide = new Int32Array(base.blocks.length).fill(-1);
  const sideToBase = new Int32Array(side.blocks.length).fill(-1);
  for (let i = 0; i < base.blocks.length; i++) {
    const start = base.starts[i];
    const at = pos[start];
    if (at < 0) continue;
    const j = side.blockOf[at];
    if (at !== side.starts[j] || base.starts[i + 1] - start !== side.starts[j + 1] - at) continue;
    let equal = true;
    for (let k = start; k < base.starts[i + 1]; k++) if (pos[k] !== at + k - start) equal = false;
    if (equal) {
      baseToSide[i] = j;
      sideToBase[j] = i;
    }
  }
  return { hunks, pos, baseToSide, sideToBase };
}
