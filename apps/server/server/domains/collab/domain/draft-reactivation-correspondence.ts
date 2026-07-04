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

export function buildBaseTargetCorrespondence<
  TBase extends CorrespondenceBlock,
  TTarget extends CorrespondenceBlock,
>(input: {
  baseBlocks: readonly TBase[];
  targetBlocks: readonly TTarget[];
}): Map<string, BaseBlockLocation<TTarget>> {
  const { baseBlocks, targetBlocks } = input;
  const baseContentCounts = contentCounts(baseBlocks);
  const targetContentCounts = contentCounts(targetBlocks);
  const targetById = new Map(targetBlocks.map((target) => [target.id, target]));
  const uniqueTargetByContent = new Map<string, TTarget>();
  const correspondence = new Map<string, BaseBlockLocation<TTarget>>();

  for (const target of targetBlocks) {
    const key = blockContentKey(target);
    if (targetContentCounts.get(key) === 1) uniqueTargetByContent.set(key, target);
  }

  for (const base of baseBlocks) {
    const target = targetById.get(base.id);
    if (target) {
      correspondence.set(base.id, { kind: "matched", target });
      continue;
    }

    const key = blockContentKey(base);
    if (baseContentCounts.get(key) === 1 && targetContentCounts.get(key) === 1) {
      const uniqueTarget = uniqueTargetByContent.get(key);
      if (uniqueTarget) {
        correspondence.set(base.id, { kind: "matched", target: uniqueTarget });
      }
    }
  }

  for (const base of baseBlocks) {
    if (correspondence.has(base.id)) continue;
    correspondence.set(base.id, { kind: "absent" });
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
