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

type AlignmentEntry =
  | { kind: "equal"; base: BlockInfo; draft: BlockInfo }
  | { kind: "change"; base: BlockInfo; draft: BlockInfo }
  | { kind: "delete"; base: BlockInfo }
  | { kind: "insert"; draft: BlockInfo };

type ReactivationAcceptDeps = {
  journal: HistoricalJournal;
  liveCoordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
};

export async function reconstructFreshAcceptUpdate(input: {
  documentId: DocumentId;
  baseLiveUpdateSeq: number;
  selectedUpdates: readonly DraftUpdate[];
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
  model: AgentEditModel;
  codec: AgentEditCodec;
}): boolean {
  let changed = false;
  const insertedEquivalents = new Map<string, string>();

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
        if (target.text !== entry.draft.text) {
          applyTextDiff(input.targetDoc, target, entry.draft.text, input.model);
          changed = true;
        }
      } else if (
        !equivalentLiveBlock(input.targetDoc, input.model, entry.draft, insertedEquivalents)
      ) {
        changed = insertDraftBlock(input, entry.draft, insertedEquivalents) || changed;
      }
      continue;
    }

    const equivalent = equivalentLiveBlock(
      input.targetDoc,
      input.model,
      entry.draft,
      insertedEquivalents,
    );
    if (equivalent) {
      insertedEquivalents.set(entry.draft.id, equivalent.id);
      continue;
    }
    changed = insertDraftBlock(input, entry.draft, insertedEquivalents) || changed;
  }

  return changed;
}

function insertDraftBlock(
  input: {
    targetDoc: Y.Doc;
    cleanDraft: Y.Doc;
    model: AgentEditModel;
    codec: AgentEditCodec;
  },
  draft: BlockInfo,
  insertedEquivalents: Map<string, string>,
): boolean {
  const targetBlocks = describeBlocks(input.targetDoc, input.model);
  const cleanBlocks = describeBlocks(input.cleanDraft, input.model);
  const draftIndex = cleanBlocks.findIndex((block) => block.id === draft.id);
  const previousTarget = findPreviousTargetBlock(
    cleanBlocks.slice(0, Math.max(0, draftIndex)),
    targetBlocks,
    insertedEquivalents,
  );
  const equivalent = blockAtInsertionPoint(targetBlocks, previousTarget, draft);
  if (equivalent) {
    insertedEquivalents.set(draft.id, equivalent.id);
    return false;
  }
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

function blockAtInsertionPoint(
  targetBlocks: readonly BlockInfo[],
  previousTarget: BlockInfo | null,
  draft: BlockInfo,
): BlockInfo | null {
  const nextIndex = previousTarget
    ? targetBlocks.findIndex((block) => block.id === previousTarget.id) + 1
    : 0;
  const candidate = targetBlocks[nextIndex];
  return candidate?.type === draft.type && candidate.text === draft.text ? candidate : null;
}

function findPreviousTargetBlock(
  previousDraftBlocks: readonly BlockInfo[],
  targetBlocks: readonly BlockInfo[],
  insertedEquivalents: Map<string, string>,
): BlockInfo | null {
  for (let index = previousDraftBlocks.length - 1; index >= 0; index -= 1) {
    const draftBlock = previousDraftBlocks[index];
    if (!draftBlock) continue;
    const equivalentId = insertedEquivalents.get(draftBlock.id) ?? draftBlock.id;
    const target = targetBlocks.find((block) => block.id === equivalentId);
    if (target) return target;
    const sameContent = targetBlocks.find(
      (block) => block.type === draftBlock.type && block.text === draftBlock.text,
    );
    if (sameContent) return sameContent;
  }
  return null;
}

function equivalentLiveBlock(
  targetDoc: Y.Doc,
  model: AgentEditModel,
  draft: BlockInfo,
  equivalents: Map<string, string>,
): BlockInfo | null {
  const targetBlocks = describeBlocks(targetDoc, model);
  return targetBlocks.find((block) => block.id === (equivalents.get(draft.id) ?? draft.id)) ?? null;
}

function applyTextDiff(
  targetDoc: Y.Doc,
  target: BlockInfo,
  desiredText: string,
  model: AgentEditModel,
): void {
  const diffs = cleanupSemantic(makeDiff(target.text, desiredText));
  const edits: { from: number; to: number; text: string }[] = [];
  let offset = 0;
  for (const [kind, text] of diffs) {
    if (kind === DIFF_EQUAL) {
      offset += text.length;
    } else if (kind === DIFF_DELETE) {
      edits.push({ from: offset, to: offset + text.length, text: "" });
      offset += text.length;
    } else if (kind === DIFF_INSERT) {
      edits.push({ from: offset, to: offset, text });
    }
  }
  for (const edit of edits.reverse()) {
    model.applyTextEdit(
      toDocHandle(targetDoc),
      target.block,
      { from: edit.from, to: edit.to },
      edit.text,
    );
  }
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
      entries.push({
        kind: base.type === draft.type && base.text === draft.text ? "equal" : "change",
        base,
        draft,
      });
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
