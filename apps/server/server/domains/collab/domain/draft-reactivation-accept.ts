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
import { buildLiveDocAtSeq } from "./draft-projection.js";
import type { DraftUpdate } from "./drafts.js";

type HistoricalJournal = Pick<UpdateJournal, "read">;

type BlockInfo = {
  id: string;
  type: string;
  text: string;
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

export class ReactivationAcceptConflictError extends Error {
  readonly blockIds: string[];

  constructor(blockIds: readonly string[]) {
    super("Reactivated draft accept overlaps live edits in the same block");
    this.name = "ReactivationAcceptConflictError";
    this.blockIds = [...new Set(blockIds)].sort();
  }
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
      Y.applyUpdate(baseDoc, update.updateData, { type: "draft" });
      Y.applyUpdate(cleanDraft, update.updateData, { type: "draft" });
    }
    for (const update of input.selectedUpdates) {
      Y.applyUpdate(cleanDraft, update.updateData, { type: "draft" });
    }
    const affected = affectedRegion(baseDoc, cleanDraft, deps.model);
    if (affected.length === 0) return null;

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
  return alignBlocks(describeBlocks(baseDoc, model), describeBlocks(cleanDraft, model)).filter(
    (entry) => entry.kind !== "equal",
  );
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
  const insertedEquivalents = new Map<string, string>();
  const conflicts: string[] = [];

  for (const entry of input.affected) {
    if (entry.kind === "delete") {
      const target = blockById(input.targetDoc, input.model, entry.base.id);
      if (target) {
        input.model.deleteBlock(toDocHandle(input.targetDoc), target.block);
        changed = true;
      }
      continue;
    }

    if (entry.kind === "change") {
      const target = blockById(input.targetDoc, input.model, entry.base.id);
      if (target) {
        const applied = applyTextSubranges({
          targetDoc: input.targetDoc,
          target,
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

    changed = insertDraftBlock(input, entry.draft, insertedEquivalents) || changed;
  }

  if (conflicts.length > 0) throw new ReactivationAcceptConflictError(conflicts);
  return changed;
}

function insertDraftBlock(
  input: {
    targetDoc: Y.Doc;
    cleanDraft: Y.Doc;
    model: AgentEditModel;
    codec: AgentEditCodec;
    allowSameBlockConflicts: boolean;
  },
  draft: BlockInfo,
  insertedEquivalents: Map<string, string>,
): boolean {
  const targetBlocks = describeBlocks(input.targetDoc, input.model);
  const cleanBlocks = describeBlocks(input.cleanDraft, input.model);
  const draftIndex = cleanBlocks.findIndex((block) => block.id === draft.id);
  const previousTarget = findInsertionAnchor(
    cleanBlocks.slice(0, Math.max(0, draftIndex)),
    cleanBlocks.slice(draftIndex + 1),
    targetBlocks,
    insertedEquivalents,
    input.allowSameBlockConflicts,
  );
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
  allowUnanchoredInsert: boolean,
): BlockInfo | null {
  const immediatePrevious = previousDraftBlocks.at(-1);
  if (immediatePrevious && followingDraftBlocks.length === 0) {
    const equivalentId = insertedEquivalents.get(immediatePrevious.id) ?? immediatePrevious.id;
    const target = targetBlocks.find((block) => block.id === equivalentId);
    return target ?? targetBlocks.at(-1) ?? null;
  }
  if (targetBlocks.length === 0) return null;
  const maxDistance = Math.max(previousDraftBlocks.length, followingDraftBlocks.length);
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    const previous = previousDraftBlocks[previousDraftBlocks.length - distance];
    if (previous) {
      const equivalentId = insertedEquivalents.get(previous.id) ?? previous.id;
      const target = targetBlocks.find((block) => block.id === equivalentId);
      if (target) return target;
    }
    const next = followingDraftBlocks[distance - 1];
    if (next) {
      const equivalentId = insertedEquivalents.get(next.id) ?? next.id;
      const targetIndex = targetBlocks.findIndex((block) => block.id === equivalentId);
      if (targetIndex >= 0) return targetBlocks[targetIndex - 1] ?? null;
    }
  }
  if (previousDraftBlocks.length > 0 || followingDraftBlocks.length > 0) {
    if (allowUnanchoredInsert) return targetBlocks.at(-1) ?? null;
    throw new ReactivationAcceptConflictError([
      previousDraftBlocks.at(-1)?.id ?? followingDraftBlocks[0]?.id ?? "unknown-block",
    ]);
  }
  return null;
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
  return model.getBlocks(toDocHandle(doc)).map((block, index) => ({
    id: model.getBlockId(block),
    type: model.getBlockType(block),
    text: model.getText(block),
    block,
    index,
  }));
}

function blockById(doc: Y.Doc, model: AgentEditModel, id: string): BlockInfo | null {
  return describeBlocks(doc, model).find((block) => block.id === id) ?? null;
}

function alignBlocks(
  baseBlocks: readonly BlockInfo[],
  draftBlocks: readonly BlockInfo[],
): AlignmentEntry[] {
  const lengths = lcsLengths(
    baseBlocks.map((block) => block.id),
    draftBlocks.map((block) => block.id),
  );
  const entries: AlignmentEntry[] = [];
  let baseIndex = 0;
  let draftIndex = 0;
  while (baseIndex < baseBlocks.length && draftIndex < draftBlocks.length) {
    const base = baseBlocks[baseIndex];
    const draft = draftBlocks[draftIndex];
    if (!base || !draft) break;
    if (base.id === draft.id) {
      entries.push(
        base.type === draft.type && base.text === draft.text
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
