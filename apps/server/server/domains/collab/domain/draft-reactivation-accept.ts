/** Reconstructs fresh accept updates for reactivated drafts whose original Yjs items are tombstoned. */

import type { UpdateJournal } from "@meridian/agent-edit";
import {
  type AgentEditCodec,
  type AgentEditModel,
  type DocumentCoordinator,
  toDocHandle,
} from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import {
  cleanupSemantic,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  makeDiff,
} from "@sanity/diff-match-patch";
import * as Y from "yjs";
import { type BlockContentShape, sameBlockContent } from "./draft-block-content.js";
import { applyDraftUpdate, buildLiveDocAtSeq } from "./draft-projection.js";
import {
  blockContentKey,
  buildBaseTargetCorrespondence,
  contentCounts,
  locateUnchangedBaseBlock,
} from "./draft-reactivation-correspondence.js";
import type { DraftUpdate } from "./drafts.js";

type HistoricalJournal = Pick<UpdateJournal, "read">;

type BlockInfo = BlockContentShape & {
  id: string;
  block: ReturnType<AgentEditModel["getBlocks"]>[number];
  index: number;
};

type TextSubrange = {
  baseStart: number;
  baseEnd: number;
  draftText: string;
  beforeText: string;
  prefix: string;
  suffix: string;
};

type AlignmentEntry =
  | { kind: "equal"; base: BlockInfo; draft: BlockInfo }
  | { kind: "change"; base: BlockInfo; draft: BlockInfo; subranges: TextSubrange[] }
  | { kind: "delete"; base: BlockInfo }
  | { kind: "insert"; draft: BlockInfo };

type ReactivationAcceptDeps = {
  journal: HistoricalJournal;
  liveCoordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
};

type ReactivationAcceptConflictReason =
  | "same_block_conflict"
  | "anchor_unlocatable"
  | "overlap_unresolvable";

type AnchorResult =
  | { kind: "anchored"; previousTarget: BlockInfo | null }
  | { kind: "unlocatable"; blockId: string };

export class ReactivationAcceptConflictError extends Error {
  readonly blockIds: string[];
  readonly reason: ReactivationAcceptConflictReason;

  constructor(
    blockIds: readonly string[],
    reason: ReactivationAcceptConflictReason = "same_block_conflict",
  ) {
    super(conflictMessage(reason));
    this.name = "ReactivationAcceptConflictError";
    this.blockIds = [...new Set(blockIds)].sort();
    this.reason = reason;
  }
}

function conflictMessage(reason: ReactivationAcceptConflictReason): string {
  if (reason === "same_block_conflict") {
    return "Reactivated draft accept overlaps live edits in the same block";
  }
  if (reason === "overlap_unresolvable") {
    return "Reactivated draft accept cannot resolve the confirmed same-block overlap";
  }
  return "Reactivated draft accept cannot locate a structural insertion anchor";
}

export async function reconstructFreshAcceptUpdate(input: {
  documentId: DocumentId;
  baseLiveUpdateSeq: number;
  selectedUpdates: readonly DraftUpdate[];
  contextUpdates?: readonly DraftUpdate[];
  allowSameBlockConflicts?: boolean;
  deps: ReactivationAcceptDeps;
}): Promise<Uint8Array | null> {
  const { deps } = input;
  const baseDoc = await buildLiveDocAtSeq(deps.journal, input.documentId, input.baseLiveUpdateSeq);
  const cleanDraft = await buildLiveDocAtSeq(
    deps.journal,
    input.documentId,
    input.baseLiveUpdateSeq,
  );
  try {
    for (const update of input.contextUpdates ?? []) {
      applyDraftUpdate(baseDoc, update);
      applyDraftUpdate(cleanDraft, update);
    }
    for (const update of input.selectedUpdates) {
      applyDraftUpdate(cleanDraft, update);
    }
    const affected = affectedRegion(baseDoc, cleanDraft, deps.model);
    if (affected.every((entry) => entry.kind === "equal")) return null;

    return await deps.liveCoordinator.withDocument(input.documentId, async (liveDoc) => {
      const targetDoc = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(targetDoc, Y.encodeStateAsUpdate(liveDoc), { type: "system" });
        const beforeVector = Y.encodeStateVector(targetDoc);
        const changed = applyAffectedRegion({
          targetDoc,
          cleanDraft,
          affected,
          allowSameBlockConflicts: input.allowSameBlockConflicts === true,
          model: deps.model,
          codec: deps.codec,
        });
        if (!changed) return null;
        return Y.encodeStateAsUpdate(targetDoc, beforeVector);
      } finally {
        targetDoc.destroy();
      }
    });
  } finally {
    baseDoc.destroy();
    cleanDraft.destroy();
  }
}

function affectedRegion(
  baseDoc: Y.Doc,
  cleanDraft: Y.Doc,
  model: AgentEditModel,
): AlignmentEntry[] {
  return alignBlocks(describeBlocks(baseDoc, model), describeBlocks(cleanDraft, model));
}

function applyAffectedRegion(input: {
  targetDoc: Y.Doc;
  cleanDraft: Y.Doc;
  affected: readonly AlignmentEntry[];
  allowSameBlockConflicts: boolean;
  model: AgentEditModel;
  codec: AgentEditCodec;
}): boolean {
  let changed = false;
  const provenTargetIdsByDraftBlockId = new Map<string, string>();
  const conflicts: string[] = [];
  const movedContentKeys = movedInsertContentKeys(input.affected);
  const correspondence = buildBaseTargetCorrespondence({
    baseBlocks: baseBlocksFromAlignment(input.affected),
    targetBlocks: describeBlocks(input.targetDoc, input.model),
  });

  for (const entry of input.affected) {
    if (entry.kind === "equal") {
      const location = correspondence.get(entry.base.id) ?? { kind: "absent" };
      if (location.kind === "matched")
        provenTargetIdsByDraftBlockId.set(entry.draft.id, location.target.id);
      continue;
    }

    if (entry.kind === "delete") {
      const location = locateUnchangedBaseBlock(correspondence, entry.base);
      if (location.kind !== "matched") {
        throw new ReactivationAcceptConflictError([entry.base.id], "overlap_unresolvable");
      }
      input.model.deleteBlock(toDocHandle(input.targetDoc), location.target.block);
      changed = true;
      continue;
    }

    if (entry.kind === "change") {
      const location = locateUnchangedBaseBlock(correspondence, entry.base);
      if (location.kind !== "matched") {
        throw new ReactivationAcceptConflictError([entry.base.id], "overlap_unresolvable");
      }
      const applied = applyTextSubranges({
        targetDoc: input.targetDoc,
        target: location.target,
        baseText: entry.base.text,
        subranges: entry.subranges,
        allowSameBlockConflicts: input.allowSameBlockConflicts,
        model: input.model,
      });
      if (applied === "conflict") conflicts.push(entry.base.id);
      else changed = applied || changed;
      continue;
    }

    if (entry.kind === "insert") {
      if (provenTargetIdsByDraftBlockId.has(entry.draft.id)) continue;
      changed =
        insertDraftBlock(
          input,
          entry.draft,
          movedContentKeys.has(blockContentKey(entry.draft))
            ? "moved-content"
            : "brand-new-content",
          provenTargetIdsByDraftBlockId,
        ) || changed;
    }
  }

  if (conflicts.length > 0) {
    throw new ReactivationAcceptConflictError(
      conflicts,
      input.allowSameBlockConflicts ? "overlap_unresolvable" : "same_block_conflict",
    );
  }
  return changed;
}

function baseBlocksFromAlignment(entries: readonly AlignmentEntry[]): BlockInfo[] {
  return entries.flatMap((entry) => ("base" in entry ? [entry.base] : []));
}

function movedInsertContentKeys(entries: readonly AlignmentEntry[]): ReadonlySet<string> {
  const deletedContentKeys = new Set<string>();
  const insertedContentKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "delete") deletedContentKeys.add(blockContentKey(entry.base));
    if (entry.kind === "insert") insertedContentKeys.add(blockContentKey(entry.draft));
  }
  return new Set([...insertedContentKeys].filter((key) => deletedContentKeys.has(key)));
}

type InsertPlacementPolicy = "moved-content" | "brand-new-content";

function insertDraftBlock(
  input: {
    targetDoc: Y.Doc;
    cleanDraft: Y.Doc;
    model: AgentEditModel;
    codec: AgentEditCodec;
  },
  draft: BlockInfo,
  placementPolicy: InsertPlacementPolicy,
  provenTargetIdsByDraftBlockId: Map<string, string>,
): boolean {
  const targetBlocks = describeBlocks(input.targetDoc, input.model);
  const cleanBlocks = describeBlocks(input.cleanDraft, input.model);
  const draftIndex = cleanBlocks.findIndex((block) => block.id === draft.id);
  const previousDraftBlocks = cleanBlocks.slice(0, Math.max(0, draftIndex));
  const followingDraftBlocks = cleanBlocks.slice(draftIndex + 1);
  const anchor =
    placementPolicy === "moved-content"
      ? findMovedContentInsertionAnchor(
          previousDraftBlocks,
          followingDraftBlocks,
          targetBlocks,
          provenTargetIdsByDraftBlockId,
        )
      : findBrandNewContentInsertionAnchor(
          previousDraftBlocks,
          followingDraftBlocks,
          targetBlocks,
          provenTargetIdsByDraftBlockId,
        );
  if (anchor.kind === "unlocatable") {
    throw new ReactivationAcceptConflictError([anchor.blockId], "anchor_unlocatable");
  }
  const previousTarget =
    anchor.kind === "anchored" ? anchor.previousTarget : (targetBlocks.at(-1) ?? null);
  const draftPmBlock = input.model.projectBlocks(toDocHandle(input.cleanDraft))[draft.index];
  if (!draftPmBlock) throw new Error("Draft block disappeared during reactivation accept");
  const [inserted] = input.model.insertBlocks(
    toDocHandle(input.targetDoc),
    previousTarget?.block ?? null,
    input.codec.parse(input.codec.serialize([draftPmBlock])),
  );
  if (!inserted) throw new Error("Draft block insert produced no block");
  provenTargetIdsByDraftBlockId.set(draft.id, input.model.getBlockId(inserted));
  return true;
}

function findMovedContentInsertionAnchor(
  previousDraftBlocks: readonly BlockInfo[],
  followingDraftBlocks: readonly BlockInfo[],
  targetBlocks: readonly BlockInfo[],
  provenTargetIdsByDraftBlockId: Map<string, string>,
): AnchorResult {
  if (targetBlocks.length === 0) return { kind: "anchored", previousTarget: null };

  const immediatePrevious = previousDraftBlocks.at(-1);
  if (immediatePrevious) {
    const previousTarget = locateEquivalentTarget(
      immediatePrevious,
      targetBlocks,
      provenTargetIdsByDraftBlockId,
    );
    if (previousTarget) return { kind: "anchored", previousTarget };
  }

  const immediateNext = followingDraftBlocks[0];
  if (immediateNext) {
    const nextTarget = locateEquivalentTarget(
      immediateNext,
      targetBlocks,
      provenTargetIdsByDraftBlockId,
    );
    if (nextTarget)
      return { kind: "anchored", previousTarget: targetBlocks[nextTarget.index - 1] ?? null };
  }

  return {
    kind: "unlocatable",
    blockId: immediatePrevious?.id ?? immediateNext?.id ?? "unknown-block",
  };
}

function locateEquivalentTarget(
  draftBlock: BlockInfo,
  targetBlocks: readonly BlockInfo[],
  provenTargetIdsByDraftBlockId: Map<string, string>,
): BlockInfo | null {
  const equivalentId = provenTargetIdsByDraftBlockId.get(draftBlock.id) ?? draftBlock.id;
  return targetBlocks.find((block) => block.id === equivalentId) ?? null;
}

function findBrandNewContentInsertionAnchor(
  previousDraftBlocks: readonly BlockInfo[],
  followingDraftBlocks: readonly BlockInfo[],
  targetBlocks: readonly BlockInfo[],
  provenTargetIdsByDraftBlockId: Map<string, string>,
): AnchorResult {
  if (targetBlocks.length === 0) return { kind: "anchored", previousTarget: null };

  const immediatePrevious = previousDraftBlocks.at(-1);
  if (immediatePrevious) {
    const previousTarget = locateEquivalentTarget(
      immediatePrevious,
      targetBlocks,
      provenTargetIdsByDraftBlockId,
    );
    if (previousTarget) return { kind: "anchored", previousTarget };
    // A previous partial accept may have recreated the draft prefix with fresh
    // Yjs item ids. Only the exact-prefix shape is deterministic: there is no
    // extra live content to choose around, so the next draft append lands after
    // the already-accepted prefix.
    if (followingDraftBlocks.length === 0 && targetBlocks.length === previousDraftBlocks.length) {
      return { kind: "anchored", previousTarget: targetBlocks.at(-1) ?? null };
    }
    return { kind: "unlocatable", blockId: immediatePrevious.id };
  }

  const immediateNext = followingDraftBlocks[0];
  if (immediateNext) {
    const nextTarget = locateEquivalentTarget(
      immediateNext,
      targetBlocks,
      provenTargetIdsByDraftBlockId,
    );
    if (nextTarget) {
      return { kind: "anchored", previousTarget: targetBlocks[nextTarget.index - 1] ?? null };
    }
    return { kind: "unlocatable", blockId: immediateNext.id };
  }

  return { kind: "unlocatable", blockId: "unknown-block" };
}

function applyTextSubranges(input: {
  targetDoc: Y.Doc;
  target: BlockInfo;
  baseText: string;
  subranges: readonly TextSubrange[];
  allowSameBlockConflicts: boolean;
  model: AgentEditModel;
}): boolean | "conflict" {
  const text = input.target.text;
  const located = input.subranges.map((range) => locateSubrange(text, range));
  if (located.some((location) => location === null)) {
    if (!input.allowSameBlockConflicts) return "conflict";
    const confirmedLocations = input.subranges.map((range) =>
      locateSubrangeByBaseDiff(input.baseText, text, range),
    );
    if (confirmedLocations.some((location) => location === null)) return "conflict";
    return applyLocatedSubranges({
      targetDoc: input.targetDoc,
      target: input.target,
      subranges: input.subranges,
      locations: confirmedLocations as { from: number; to: number }[],
      model: input.model,
      text,
    });
  }

  return applyLocatedSubranges({
    targetDoc: input.targetDoc,
    target: input.target,
    subranges: input.subranges,
    locations: located as { from: number; to: number }[],
    model: input.model,
    text,
  });
}

function applyLocatedSubranges(input: {
  targetDoc: Y.Doc;
  target: BlockInfo;
  subranges: readonly TextSubrange[];
  locations: readonly { from: number; to: number }[];
  model: AgentEditModel;
  text: string;
}): boolean {
  let changed = false;
  let text = input.text;
  const edits = input.subranges.map((range, index) => ({
    range,
    location: input.locations[index] as { from: number; to: number },
  }));
  for (const edit of edits.reverse()) {
    if (text.slice(edit.location.from, edit.location.to) !== edit.range.draftText) {
      input.model.applyTextEdit(
        toDocHandle(input.targetDoc),
        input.target.block,
        { from: edit.location.from, to: edit.location.to },
        edit.range.draftText,
      );
      text = `${text.slice(0, edit.location.from)}${edit.range.draftText}${text.slice(edit.location.to)}`;
      changed = true;
    }
  }
  return changed;
}

function locateSubrangeByBaseDiff(
  baseText: string,
  liveText: string,
  range: TextSubrange,
): { from: number; to: number } | null {
  const from = mapBaseOffsetToLive(baseText, liveText, range.baseStart, -1);
  const to = mapBaseOffsetToLive(baseText, liveText, range.baseEnd, 1);
  if (from === null || to === null || from > to) return null;
  if (range.beforeText.length > 0 && from === to) return null;
  return { from, to };
}

function mapBaseOffsetToLive(
  baseText: string,
  liveText: string,
  offset: number,
  assoc: -1 | 1,
): number | null {
  const diffs = cleanupSemantic(makeDiff(baseText, liveText));
  let baseOffset = 0;
  let liveOffset = 0;
  for (const [kind, text] of diffs) {
    if (kind === DIFF_EQUAL) {
      if (offset <= baseOffset + text.length) return liveOffset + (offset - baseOffset);
      baseOffset += text.length;
      liveOffset += text.length;
    } else if (kind === DIFF_DELETE) {
      if (offset <= baseOffset + text.length) return liveOffset;
      baseOffset += text.length;
    } else if (kind === DIFF_INSERT) {
      if (offset < baseOffset || (offset === baseOffset && assoc < 0)) return liveOffset;
      liveOffset += text.length;
    }
  }
  return offset === baseOffset ? liveOffset : null;
}

function locateSubrange(
  liveText: string,
  range: TextSubrange,
): { from: number; to: number } | null {
  const candidates: { from: number; to: number; score: number }[] = [];
  if (range.beforeText.length > 0) {
    let index = liveText.indexOf(range.beforeText);
    while (index !== -1) {
      const before = liveText.slice(Math.max(0, index - range.prefix.length), index);
      const after = liveText.slice(
        index + range.beforeText.length,
        index + range.beforeText.length + range.suffix.length,
      );
      if (before.endsWith(range.prefix) && after.startsWith(range.suffix)) {
        candidates.push({
          from: index,
          to: index + range.beforeText.length,
          score: contextScore(range),
        });
      }
      index = liveText.indexOf(range.beforeText, index + 1);
    }
  } else {
    for (let index = 0; index <= liveText.length; index += 1) {
      const before = liveText.slice(Math.max(0, index - range.prefix.length), index);
      const after = liveText.slice(index, index + range.suffix.length);
      if (before.endsWith(range.prefix) && after.startsWith(range.suffix)) {
        candidates.push({ from: index, to: index, score: contextScore(range) });
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function contextScore(range: TextSubrange): number {
  return range.prefix.length + range.suffix.length;
}

function changedSubranges(baseText: string, draftText: string): TextSubrange[] {
  const diffs = cleanupSemantic(makeDiff(baseText, draftText));
  const ranges: { baseStart: number; baseEnd: number; draftText: string; beforeText: string }[] =
    [];
  let baseOffset = 0;
  let current: {
    baseStart: number;
    baseEnd: number;
    beforeText: string;
    draftText: string;
  } | null = null;
  const flush = () => {
    if (!current) return;
    ranges.push(current);
    current = null;
  };
  for (const [kind, text] of diffs) {
    if (kind === DIFF_EQUAL) {
      flush();
      baseOffset += text.length;
      continue;
    }
    current ??= { baseStart: baseOffset, baseEnd: baseOffset, beforeText: "", draftText: "" };
    if (kind === DIFF_DELETE) {
      current.beforeText += text;
      current.baseEnd += text.length;
      baseOffset += text.length;
    } else if (kind === DIFF_INSERT) {
      current.draftText += text;
    }
  }
  flush();
  return ranges.map((range) => ({
    ...range,
    prefix: baseText.slice(Math.max(0, range.baseStart - 24), range.baseStart),
    suffix: baseText.slice(range.baseEnd, range.baseEnd + 24),
  }));
}

function describeBlocks(doc: Y.Doc, model: AgentEditModel): BlockInfo[] {
  const blocks = model.getBlocks(toDocHandle(doc));
  return blocks.map((block, index) => ({
    id: model.getBlockId(block),
    type: model.getBlockType(block),
    text: model.getText(block),
    block,
    index,
  }));
}

function alignBlocks(
  baseBlocks: readonly BlockInfo[],
  draftBlocks: readonly BlockInfo[],
): AlignmentEntry[] {
  const prefix: AlignmentEntry[] = [];
  let start = 0;
  while (
    start < baseBlocks.length &&
    start < draftBlocks.length &&
    sameBlockContent(baseBlocks[start] as BlockInfo, draftBlocks[start] as BlockInfo)
  ) {
    prefix.push({
      kind: "equal",
      base: baseBlocks[start] as BlockInfo,
      draft: draftBlocks[start] as BlockInfo,
    });
    start += 1;
  }

  const suffix: AlignmentEntry[] = [];
  let baseEnd = baseBlocks.length;
  let draftEnd = draftBlocks.length;
  while (
    baseEnd > start &&
    draftEnd > start &&
    sameBlockContent(baseBlocks[baseEnd - 1] as BlockInfo, draftBlocks[draftEnd - 1] as BlockInfo)
  ) {
    baseEnd -= 1;
    draftEnd -= 1;
    suffix.unshift({
      kind: "equal",
      base: baseBlocks[baseEnd] as BlockInfo,
      draft: draftBlocks[draftEnd] as BlockInfo,
    });
  }

  const baseRegion = baseBlocks.slice(start, baseEnd);
  const draftRegion = draftBlocks.slice(start, draftEnd);
  const baseContentCounts = contentCounts(baseRegion);
  const draftContentCounts = contentCounts(draftRegion);
  const blocksAlignInThisRegion = (left: BlockInfo, right: BlockInfo) =>
    blocksAlign(left, right, baseContentCounts, draftContentCounts);
  const lengths = lcsLengths(baseRegion, draftRegion, blocksAlignInThisRegion);
  const entries: AlignmentEntry[] = [...prefix];
  let baseIndex = 0;
  let draftIndex = 0;
  while (baseIndex < baseRegion.length && draftIndex < draftRegion.length) {
    const base = baseRegion[baseIndex];
    const draft = draftRegion[draftIndex];
    if (!base || !draft) break;
    if (blocksAlignInThisRegion(base, draft)) {
      entries.push(
        sameBlockContent(base, draft)
          ? { kind: "equal", base, draft }
          : { kind: "change", base, draft, subranges: changedSubranges(base.text, draft.text) },
      );
      baseIndex += 1;
      draftIndex += 1;
    } else if (lengths[baseIndex + 1][draftIndex] >= lengths[baseIndex][draftIndex + 1]) {
      entries.push({ kind: "delete", base });
      baseIndex += 1;
    } else {
      entries.push({ kind: "insert", draft });
      draftIndex += 1;
    }
  }
  while (baseIndex < baseRegion.length) {
    const base = baseRegion[baseIndex++];
    if (base) entries.push({ kind: "delete", base });
  }
  while (draftIndex < draftRegion.length) {
    const draft = draftRegion[draftIndex++];
    if (draft) entries.push({ kind: "insert", draft });
  }
  entries.push(...suffix);
  return entries;
}

function blocksAlign(
  left: BlockInfo,
  right: BlockInfo,
  leftContentCounts: ReadonlyMap<string, number>,
  rightContentCounts: ReadonlyMap<string, number>,
): boolean {
  if (left.id === right.id) return true;
  if (!sameBlockContent(left, right)) return false;
  const key = blockContentKey(left);
  return leftContentCounts.get(key) === 1 && rightContentCounts.get(key) === 1;
}

function lcsLengths<T>(
  left: readonly T[],
  right: readonly T[],
  equals: (left: T, right: T) => boolean,
): number[][] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = equals(left[i] as T, right[j] as T)
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  return lengths;
}
