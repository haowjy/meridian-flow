/** Resolves reactivated draft base blocks to live targets without guessing. */

import { type BlockContentShape, sameBlockContent } from "./draft-block-content.js";

export type CorrespondenceBlock = BlockContentShape & {
  id: string;
  index: number;
};

export type BaseBlockLocation<TTarget extends CorrespondenceBlock> =
  | { kind: "matched"; target: TTarget }
  | { kind: "absent" }
  | { kind: "conflict" };

export type BaseTargetAlignmentEntry<TBase extends CorrespondenceBlock> =
  | { kind: "equal"; base: TBase }
  | { kind: "change"; base: TBase }
  | { kind: "delete"; base: TBase }
  | { kind: "insert" };

export function buildBaseTargetCorrespondence<
  TBase extends CorrespondenceBlock,
  TTarget extends CorrespondenceBlock,
>(input: {
  baseBlocks: readonly TBase[];
  targetBlocks: readonly TTarget[];
  affected: readonly BaseTargetAlignmentEntry<TBase>[];
  classifyAbsentSlots: boolean;
}): Map<string, BaseBlockLocation<TTarget>> {
  const { baseBlocks, targetBlocks } = input;
  const baseContentCounts = contentCounts(baseBlocks);
  const targetContentCounts = contentCounts(targetBlocks);
  const targetById = new Map(targetBlocks.map((target) => [target.id, target]));
  const uniqueTargetByContent = new Map<string, TTarget>();
  const correspondence = new Map<string, BaseBlockLocation<TTarget>>();
  const usedTargetIds = new Set<string>();

  for (const target of targetBlocks) {
    const key = blockContentKey(target);
    if (targetContentCounts.get(key) === 1) uniqueTargetByContent.set(key, target);
  }

  for (const base of baseBlocks) {
    const target = targetById.get(base.id);
    if (target) {
      correspondence.set(base.id, { kind: "matched", target });
      usedTargetIds.add(target.id);
      continue;
    }

    const key = blockContentKey(base);
    if (baseContentCounts.get(key) === 1 && targetContentCounts.get(key) === 1) {
      const uniqueTarget = uniqueTargetByContent.get(key);
      if (uniqueTarget) {
        correspondence.set(base.id, { kind: "matched", target: uniqueTarget });
        usedTargetIds.add(uniqueTarget.id);
      }
    }
  }

  for (const entry of input.affected) {
    if (entry.kind !== "equal" || correspondence.has(entry.base.id)) continue;
    const targetAtSamePosition = targetBlocks[entry.base.index];
    if (
      targetAtSamePosition &&
      !usedTargetIds.has(targetAtSamePosition.id) &&
      sameBlockContent(entry.base, targetAtSamePosition)
    ) {
      correspondence.set(entry.base.id, { kind: "matched", target: targetAtSamePosition });
      usedTargetIds.add(targetAtSamePosition.id);
    }
  }

  const matchedTargetIndexByBaseId = new Map<string, number>();
  for (const [baseId, location] of correspondence) {
    if (location.kind !== "matched") continue;
    matchedTargetIndexByBaseId.set(baseId, location.target.index);
  }

  for (const base of baseBlocks) {
    if (correspondence.has(base.id)) continue;
    correspondence.set(
      base.id,
      input.classifyAbsentSlots
        ? classifyMissingBaseBlockSlot(base, baseBlocks, targetBlocks, matchedTargetIndexByBaseId)
        : { kind: "absent" },
    );
  }

  return correspondence;
}

export function locateUnchangedBaseBlock<TTarget extends CorrespondenceBlock>(
  correspondence: ReadonlyMap<string, BaseBlockLocation<TTarget>>,
  base: CorrespondenceBlock,
): BaseBlockLocation<TTarget> {
  const location = correspondence.get(base.id) ?? { kind: "absent" };
  if (location.kind !== "matched") return location;
  return sameBlockContent(location.target, base) ? location : { kind: "conflict" };
}

export function blockContentKey(block: BlockContentShape): string {
  return `${block.type}\u0000${block.text}`;
}

export function contentCounts(blocks: readonly BlockContentShape[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const key = blockContentKey(block);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function classifyMissingBaseBlockSlot<
  TBase extends CorrespondenceBlock,
  TTarget extends CorrespondenceBlock,
>(
  base: TBase,
  baseBlocks: readonly TBase[],
  targetBlocks: readonly TTarget[],
  matchedTargetIndexByBaseId: ReadonlyMap<string, number>,
): BaseBlockLocation<TTarget> {
  const baseIndex = baseBlocks.findIndex((block) => block.id === base.id);
  if (baseIndex < 0) return { kind: "conflict" };

  const previousIndex = nearestMatchedBaseAnchorIndex(
    baseBlocks.slice(0, baseIndex).reverse(),
    matchedTargetIndexByBaseId,
  );
  const nextIndex = nearestMatchedBaseAnchorIndex(
    baseBlocks.slice(baseIndex + 1),
    matchedTargetIndexByBaseId,
  );
  if (previousIndex === null && nextIndex === null) return { kind: "conflict" };
  if (previousIndex !== null && nextIndex !== null && previousIndex >= nextIndex) {
    return { kind: "conflict" };
  }

  const slotStart = previousIndex === null ? 0 : previousIndex + 1;
  const slotEnd = nextIndex === null ? targetBlocks.length : nextIndex;
  return slotStart < slotEnd ? { kind: "conflict" } : { kind: "absent" };
}

function nearestMatchedBaseAnchorIndex(
  candidates: readonly CorrespondenceBlock[],
  matchedTargetIndexByBaseId: ReadonlyMap<string, number>,
): number | null {
  for (const candidate of candidates) {
    const index = matchedTargetIndexByBaseId.get(candidate.id);
    if (index !== undefined) return index;
  }
  return null;
}
