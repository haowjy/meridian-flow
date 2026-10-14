/** Aligns two documents block by block by Yjs identity and reports which clock ranges each block change supplied or removed. */
import { isDeepStrictEqual } from "node:util";
import {
  type AgentEditModel,
  type BlockRef,
  toDocHandle,
  unwrapBlock,
} from "@meridian/agent-edit/integration";
import type * as Y from "yjs";
import {
  documentProseEqual,
  richDifference,
  textContentShape,
  visibleContent,
  visibleItemRanges,
} from "./document-content.js";
import type { ClockRange } from "./journal-clock-owners.js";

type BlockInfo = {
  id: string;
  identity: string;
  type: string;
  text: string;
  content: unknown;
  effectRanges: ClockRange[];
  block: BlockRef;
};

type BlockAlignmentInput = { id: string; identity?: string; content?: unknown };

type AlignmentEntry<T extends BlockAlignmentInput = BlockInfo> =
  | { kind: "equal"; live: T; draft: T }
  | { kind: "change"; live: T; draft: T }
  | { kind: "delete"; live: T }
  | { kind: "insert"; draft: T };

/** Both immutable identities and all supplying effects survive presentation pairing. */
type DocumentDifferenceEntry =
  | Exclude<AlignmentEntry, { kind: "change" }>
  | {
      kind: "change";
      live: BlockInfo;
      draft: BlockInfo;
      effects: { insertedRanges: ClockRange[]; deletedRanges: ClockRange[] };
    };

function describeBlocks(doc: Y.Doc, model: AgentEditModel): BlockInfo[] {
  const handle = toDocHandle(doc);
  const blocks = model.getBlocks(handle);
  const ids = model.getDocumentBlockIds(handle);
  return blocks.map((block, index) => ({
    id: ids[index],
    identity: JSON.stringify(model.getCanonicalBlockIdentity(block)),
    type: model.getBlockType(block),
    text: model.getText(block),
    content: visibleContent(unwrapBlock(block)),
    effectRanges: visibleItemRanges(unwrapBlock(block)),
    block,
  }));
}

/** Inserted and removed clock ranges per changed block, keyed by the block ids the trail uses. */
export function changedRangesByBlock(
  difference: readonly DocumentDifferenceEntry[],
): Map<string, { insertedRanges: ClockRange[]; deletedRanges: ClockRange[] }> {
  const result = new Map<string, { insertedRanges: ClockRange[]; deletedRanges: ClockRange[] }>();
  const add = (
    key: string,
    ranges: { insertedRanges: ClockRange[]; deletedRanges: ClockRange[] },
  ) => {
    const existing = result.get(key) ?? { insertedRanges: [], deletedRanges: [] };
    existing.insertedRanges.push(...ranges.insertedRanges);
    existing.deletedRanges.push(...ranges.deletedRanges);
    result.set(key, existing);
  };
  for (const entry of difference) {
    if (entry.kind === "insert")
      add(entry.draft.id, { insertedRanges: entry.draft.effectRanges, deletedRanges: [] });
    else if (entry.kind === "delete")
      add(entry.live.id, { insertedRanges: [], deletedRanges: entry.live.effectRanges });
    else if (entry.kind === "change") {
      add(entry.draft.id, entry.effects);
      if (entry.live.id !== entry.draft.id) add(entry.live.id, entry.effects);
    }
  }
  return result;
}

export function alignBlocks<T extends BlockAlignmentInput>(
  liveBlocks: readonly T[],
  draftBlocks: readonly T[],
): AlignmentEntry<T>[] {
  const entries: AlignmentEntry<T>[] = [];
  const pair = (live: T, draft: T) =>
    entries.push({
      kind: blockContentMatches(live, draft) ? "equal" : "change",
      live,
      draft,
    });
  let liveIndex = 0,
    draftIndex = 0;
  while (
    liveIndex < liveBlocks.length &&
    draftIndex < draftBlocks.length &&
    alignmentIdentity(liveBlocks[liveIndex]) === alignmentIdentity(draftBlocks[draftIndex])
  ) {
    pair(liveBlocks[liveIndex], draftBlocks[draftIndex]);
    liveIndex++;
    draftIndex++;
  }
  const offset = liveIndex;
  let liveEnd = liveBlocks.length,
    draftEnd = draftBlocks.length;
  // Duplicate IDs make suffix matching ambiguous under the LCS tie rule.
  const uniqueIds = (blocks: readonly T[]) => {
    const counts = new Map<string, number>();
    for (const block of blocks)
      counts.set(alignmentIdentity(block), (counts.get(alignmentIdentity(block)) ?? 0) + 1);
    return counts;
  };
  const liveCounts = uniqueIds(liveBlocks.slice(offset)),
    draftCounts = uniqueIds(draftBlocks.slice(offset));
  while (liveEnd > offset && draftEnd > offset) {
    const id = alignmentIdentity(liveBlocks[liveEnd - 1]);
    if (
      id !== alignmentIdentity(draftBlocks[draftEnd - 1]) ||
      liveCounts.get(id) !== 1 ||
      draftCounts.get(id) !== 1
    )
      break;
    liveEnd--;
    draftEnd--;
  }
  const lengths =
    liveIndex < liveEnd && draftIndex < draftEnd
      ? lcsLengths(
          liveBlocks.slice(offset, liveEnd).map(alignmentIdentity),
          draftBlocks.slice(offset, draftEnd).map(alignmentIdentity),
        )
      : [];
  while (liveIndex < liveEnd && draftIndex < draftEnd) {
    if (alignmentIdentity(liveBlocks[liveIndex]) === alignmentIdentity(draftBlocks[draftIndex])) {
      const live = liveBlocks[liveIndex];
      const draft = draftBlocks[draftIndex];
      entries.push({
        kind: blockContentMatches(live, draft) ? "equal" : "change",
        live,
        draft,
      });
      liveIndex += 1;
      draftIndex += 1;
    } else if (
      lengths[liveIndex - offset + 1][draftIndex - offset] >=
      lengths[liveIndex - offset][draftIndex - offset + 1]
    ) {
      entries.push({ kind: "delete", live: liveBlocks[liveIndex] });
      liveIndex += 1;
    } else {
      entries.push({ kind: "insert", draft: draftBlocks[draftIndex] });
      draftIndex += 1;
    }
  }
  while (liveIndex < liveEnd) {
    entries.push({ kind: "delete", live: liveBlocks[liveIndex] });
    liveIndex += 1;
  }
  while (draftIndex < draftEnd) {
    entries.push({ kind: "insert", draft: draftBlocks[draftIndex] });
    draftIndex += 1;
  }
  while (liveEnd < liveBlocks.length) {
    pair(liveBlocks[liveEnd++], draftBlocks[draftEnd++]);
  }
  return entries;
}

function blockContentMatches(live: BlockAlignmentInput, draft: BlockAlignmentInput): boolean {
  return isDeepStrictEqual(live.content, draft.content);
}

function lcsLengths(left: readonly string[], right: readonly string[]): number[][] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  return lengths;
}

function changedBlocks(live: BlockInfo, draft: BlockInfo): DocumentDifferenceEntry {
  const rich =
    live.identity === draft.identity &&
    isDeepStrictEqual(
      textContentShape(unwrapBlock(live.block)),
      textContentShape(unwrapBlock(draft.block)),
    )
      ? richDifference(unwrapBlock(live.block), unwrapBlock(draft.block))
      : null;
  return {
    kind: "change",
    live,
    draft,
    effects: {
      insertedRanges: rich?.insertedRanges ?? subtractRanges(draft.effectRanges, live.effectRanges),
      deletedRanges: rich?.deletedRanges ?? subtractRanges(live.effectRanges, draft.effectRanges),
    },
  };
}

export function subtractRanges(
  ranges: readonly ClockRange[],
  retained: readonly ClockRange[],
): ClockRange[] {
  return ranges.flatMap((range) => {
    let parts = [range];
    for (const other of retained) {
      if (other.client !== range.client) continue;
      parts = parts.flatMap((part) => {
        const start = Math.max(part.clock, other.clock);
        const end = Math.min(part.clock + part.length, other.clock + other.length);
        if (end <= start) return [part];
        return [
          ...(start > part.clock ? [{ ...part, length: start - part.clock }] : []),
          ...(end < part.clock + part.length
            ? [{ ...part, clock: end, length: part.clock + part.length - end }]
            : []),
        ];
      });
    }
    return parts;
  });
}

export function documentDifference(
  live: Y.Doc,
  draft: Y.Doc,
  model: AgentEditModel,
): DocumentDifferenceEntry[] {
  if (documentProseEqual(live, draft)) return [];
  const alignment = alignBlocks(describeBlocks(live, model), describeBlocks(draft, model));
  const difference: DocumentDifferenceEntry[] = [];
  for (let index = 0; index < alignment.length; ) {
    const entry = alignment[index];
    if (entry.kind === "equal" || entry.kind === "change") {
      difference.push(entry.kind === "change" ? changedBlocks(entry.live, entry.draft) : entry);
      index++;
      continue;
    }
    // Identity alignment bounds a replacement gap. Equal ordered content is a
    // semantic no-op at any length, not evidence of cross-block provenance.
    const removed: BlockInfo[] = [];
    const added: BlockInfo[] = [];
    const gap: AlignmentEntry[] = [];
    while (index < alignment.length) {
      const candidate = alignment[index];
      if (candidate.kind !== "delete" && candidate.kind !== "insert") break;
      gap.push(candidate);
      if (candidate.kind === "delete") removed.push(candidate.live);
      else added.push(candidate.draft);
      index++;
    }
    if (
      removed.length === added.length &&
      removed.every((block, offset) => blockContentMatches(block, added[offset]))
    ) {
      difference.push(
        ...removed.map((block, offset) => ({
          kind: "equal" as const,
          live: block,
          draft: added[offset],
        })),
      );
      continue;
    }
    for (let offset = 0; offset < gap.length; offset++) {
      const current = gap[offset],
        next = gap[offset + 1];
      if (
        current.kind === "delete" &&
        next?.kind === "insert" &&
        current.live.text === next.draft.text
      ) {
        difference.push(changedBlocks(current.live, next.draft));
        offset++;
      } else if (current.kind === "delete" || current.kind === "insert") difference.push(current);
    }
  }
  return difference;
}

function alignmentIdentity(block: BlockAlignmentInput): string {
  return block.identity ?? block.id;
}
