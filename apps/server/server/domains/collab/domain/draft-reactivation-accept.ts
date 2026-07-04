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

export type ReactivationAcceptMode = "strict" | "lossless_merge";

type ReactivationAcceptConflictReason =
  | "same_block_conflict"
  | "anchor_unlocatable"
  | "overlap_unresolvable";

type AnchorResult =
  | { kind: "anchored"; previousTarget: BlockInfo | null }
  | { kind: "unlocatable"; blockId: string };

type BaseBlockLocation =
  | { kind: "matched"; target: BlockInfo }
  | { kind: "absent" }
  | { kind: "conflict" };

type BaseBlockOperation = "delete" | "change";

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
  mode: ReactivationAcceptMode;
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
          mode: input.mode,
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
  mode: ReactivationAcceptMode;
  model: AgentEditModel;
  codec: AgentEditCodec;
}): boolean {
  let changed = false;
  const insertedEquivalents = new Map<string, string>();
  const conflicts: string[] = [];
  const correspondence = buildBaseTargetCorrespondence({
    targetDoc: input.targetDoc,
    affected: input.affected,
    mode: input.mode,
    model: input.model,
  });
  const preservedDuplicateContent = preservedDuplicateDeleteInsertPairs(input.affected);

  for (const entry of input.affected) {
    if (entry.kind === "equal") {
      const location = correspondence.get(entry.base.id) ?? { kind: "absent" };
      if (location.kind === "matched") insertedEquivalents.set(entry.draft.id, location.target.id);
      continue;
    }

    if (entry.kind === "delete") {
      const preservedDraftId = preservedDuplicateContent.get(entry.base.id);
      if (preservedDraftId) {
        const location = correspondence.get(entry.base.id) ?? { kind: "absent" };
        if (location.kind === "matched")
          insertedEquivalents.set(preservedDraftId, location.target.id);
        continue;
      }
      const location = locateBaseBlockInTarget(correspondence, entry.base, "delete");
      if (location.kind === "conflict") {
        throw new ReactivationAcceptConflictError([entry.base.id], "overlap_unresolvable");
      }
      if (location.kind === "absent") continue;
      input.model.deleteBlock(toDocHandle(input.targetDoc), location.target.block);
      changed = true;
      continue;
    }

    if (entry.kind === "change") {
      const location = locateBaseBlockInTarget(correspondence, entry.base, "change");
      if (location.kind === "conflict") {
        throw new ReactivationAcceptConflictError([entry.base.id], "overlap_unresolvable");
      }
      if (location.kind === "matched") {
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
      } else {
        changed = insertDraftBlock(input, entry.draft, insertedEquivalents) || changed;
      }
      continue;
    }

    if (entry.kind === "insert") {
      if (insertedEquivalents.has(entry.draft.id)) continue;
      changed = insertDraftBlock(input, entry.draft, insertedEquivalents) || changed;
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

function preservedDuplicateDeleteInsertPairs(
  entries: readonly AlignmentEntry[],
): Map<string, string> {
  // Duplicate content is deliberately excluded from LCS content matching so
  // structural insert anchors do not collapse onto the wrong repeated block.
  // When the diff consequently emits duplicate unchanged content as
  // delete+insert churn, pair only repeated entries back into no-op
  // correspondences. Unique delete+insert pairs still represent real moves.
  const deletesByContent = new Map<string, BlockInfo[]>();
  const insertsByContent = new Map<string, BlockInfo[]>();
  for (const entry of entries) {
    if (entry.kind === "delete") {
      const key = blockContentKey(entry.base);
      const deletes = deletesByContent.get(key) ?? [];
      deletes.push(entry.base);
      deletesByContent.set(key, deletes);
    } else if (entry.kind === "insert") {
      const key = blockContentKey(entry.draft);
      const inserts = insertsByContent.get(key) ?? [];
      inserts.push(entry.draft);
      insertsByContent.set(key, inserts);
    }
  }

  const pairs = new Map<string, string>();
  for (const [key, deletes] of deletesByContent) {
    const inserts = insertsByContent.get(key) ?? [];
    if (deletes.length < 2 && inserts.length < 2) continue;
    for (let index = 0; index < Math.min(deletes.length, inserts.length); index += 1) {
      const base = deletes[index];
      const draft = inserts[index];
      if (base && draft) pairs.set(base.id, draft.id);
    }
  }
  return pairs;
}

/**
 * Builds the immutable base-to-target correspondence before replay mutates the
 * target document. Y.XmlElement references remain valid through unrelated
 * inserts/deletes, so operations can address the chosen block without re-reading
 * positional anchors from a changed document.
 */
function buildBaseTargetCorrespondence(input: {
  targetDoc: Y.Doc;
  affected: readonly AlignmentEntry[];
  mode: ReactivationAcceptMode;
  model: AgentEditModel;
}): Map<string, BaseBlockLocation> {
  const baseBlocks = baseBlocksFromAlignment(input.affected);
  const targetBlocks = describeBlocks(input.targetDoc, input.model);
  const correspondence = new Map<string, BaseBlockLocation>();
  const usedTargetIds = new Set<string>();

  for (const base of baseBlocks) {
    const target = targetBlocks.find((block) => block.id === base.id);
    if (!target) continue;
    correspondence.set(base.id, { kind: "matched", target });
    usedTargetIds.add(target.id);
  }

  if (input.mode === "lossless_merge") {
    const targetsByContent = new Map<string, BlockInfo[]>();
    for (const target of targetBlocks) {
      if (usedTargetIds.has(target.id)) continue;
      const key = blockContentKey(target);
      const targets = targetsByContent.get(key) ?? [];
      targets.push(target);
      targetsByContent.set(key, targets);
    }

    for (const base of baseBlocks) {
      if (correspondence.has(base.id)) continue;
      const targets = targetsByContent.get(blockContentKey(base));
      const target = targets?.shift();
      if (!target) continue;
      correspondence.set(base.id, { kind: "matched", target });
      usedTargetIds.add(target.id);
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
      input.mode === "strict"
        ? { kind: "absent" }
        : classifyMissingBaseBlockSlot(base, baseBlocks, targetBlocks, matchedTargetIndexByBaseId),
    );
  }

  return correspondence;
}

function locateBaseBlockInTarget(
  correspondence: ReadonlyMap<string, BaseBlockLocation>,
  base: BlockInfo,
  operation: BaseBlockOperation,
): BaseBlockLocation {
  const location = correspondence.get(base.id) ?? { kind: "absent" };
  if (location.kind !== "matched") return location;
  if (operation === "delete" && !sameBlockContent(location.target, base)) {
    return { kind: "conflict" };
  }
  return location;
}

function baseBlocksFromAlignment(entries: readonly AlignmentEntry[]): BlockInfo[] {
  return entries.flatMap((entry) => ("base" in entry ? [entry.base] : []));
}

function classifyMissingBaseBlockSlot(
  base: BlockInfo,
  baseBlocks: readonly BlockInfo[],
  targetBlocks: readonly BlockInfo[],
  matchedTargetIndexByBaseId: ReadonlyMap<string, number>,
): BaseBlockLocation {
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
  candidates: readonly BlockInfo[],
  matchedTargetIndexByBaseId: ReadonlyMap<string, number>,
): number | null {
  for (const candidate of candidates) {
    const index = matchedTargetIndexByBaseId.get(candidate.id);
    if (index !== undefined) return index;
  }
  return null;
}

function insertDraftBlock(
  input: {
    targetDoc: Y.Doc;
    cleanDraft: Y.Doc;
    model: AgentEditModel;
    codec: AgentEditCodec;
    mode: ReactivationAcceptMode;
  },
  draft: BlockInfo,
  insertedEquivalents: Map<string, string>,
): boolean {
  const targetBlocks = describeBlocks(input.targetDoc, input.model);
  const cleanBlocks = describeBlocks(input.cleanDraft, input.model);
  const draftIndex = cleanBlocks.findIndex((block) => block.id === draft.id);
  const anchor = findInsertionAnchor(
    cleanBlocks.slice(0, Math.max(0, draftIndex)),
    cleanBlocks.slice(draftIndex + 1),
    targetBlocks,
    insertedEquivalents,
  );
  if (anchor.kind === "unlocatable" && input.mode === "strict") {
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
  insertedEquivalents.set(draft.id, input.model.getBlockId(inserted));
  return true;
}

function findInsertionAnchor(
  previousDraftBlocks: readonly BlockInfo[],
  followingDraftBlocks: readonly BlockInfo[],
  targetBlocks: readonly BlockInfo[],
  insertedEquivalents: Map<string, string>,
): AnchorResult {
  if (targetBlocks.length === 0) return { kind: "anchored", previousTarget: null };

  const immediatePrevious = previousDraftBlocks.at(-1);
  if (immediatePrevious && followingDraftBlocks.length === 0) {
    const equivalentId = insertedEquivalents.get(immediatePrevious.id) ?? immediatePrevious.id;
    const target = targetBlocks.find((block) => block.id === equivalentId);
    if (target) return { kind: "anchored", previousTarget: target };
    // A previous partial accept may have recreated the draft prefix with fresh
    // Yjs item ids. Only the exact-prefix shape is deterministic: there is no
    // extra live content to choose around, so the next draft append lands after
    // the already-accepted prefix.
    if (targetBlocks.length === previousDraftBlocks.length) {
      return { kind: "anchored", previousTarget: targetBlocks.at(-1) ?? null };
    }
    return { kind: "unlocatable", blockId: immediatePrevious.id };
  }

  const maxDistance = Math.max(previousDraftBlocks.length, followingDraftBlocks.length);
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    const previous = previousDraftBlocks[previousDraftBlocks.length - distance];
    if (previous) {
      const equivalentId = insertedEquivalents.get(previous.id) ?? previous.id;
      const target = targetBlocks.find((block) => block.id === equivalentId);
      if (target) return { kind: "anchored", previousTarget: target };
    }
    const next = followingDraftBlocks[distance - 1];
    if (next) {
      const equivalentId = insertedEquivalents.get(next.id) ?? next.id;
      const targetIndex = targetBlocks.findIndex((block) => block.id === equivalentId);
      if (targetIndex >= 0) {
        return { kind: "anchored", previousTarget: targetBlocks[targetIndex - 1] ?? null };
      }
    }
  }

  return {
    kind: "unlocatable",
    blockId: previousDraftBlocks.at(-1)?.id ?? followingDraftBlocks[0]?.id ?? "unknown-block",
  };
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
  const baseContentCounts = contentCounts(baseBlocks);
  const draftContentCounts = contentCounts(draftBlocks);
  const blocksAlignInThisRegion = (left: BlockInfo, right: BlockInfo) =>
    blocksAlign(left, right, baseContentCounts, draftContentCounts);
  const lengths = lcsLengths(baseBlocks, draftBlocks, blocksAlignInThisRegion);
  const entries: AlignmentEntry[] = [];
  let baseIndex = 0;
  let draftIndex = 0;
  while (baseIndex < baseBlocks.length && draftIndex < draftBlocks.length) {
    const base = baseBlocks[baseIndex];
    const draft = draftBlocks[draftIndex];
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
  while (baseIndex < baseBlocks.length) {
    const base = baseBlocks[baseIndex++];
    if (base) entries.push({ kind: "delete", base });
  }
  while (draftIndex < draftBlocks.length) {
    const draft = draftBlocks[draftIndex++];
    if (draft) entries.push({ kind: "insert", draft });
  }
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

function contentCounts(blocks: readonly BlockInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const key = blockContentKey(block);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function blockContentKey(block: BlockContentShape): string {
  return `${block.type}\u0000${block.text}`;
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
