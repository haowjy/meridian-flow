// Cold reversal update synthesis, including plain-text order repair.
import * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import { reconstructUndoUpdateFromSnapshot } from "./reconstruction.js";
import type { ReversalPlan } from "./reversal-plan.js";

type PreparedPlan = Extract<ReversalPlan, { ok: true }>;

export function reconstructReversalUpdate(input: {
  direction: "undo" | "redo";
  docId: string;
  targetId: string;
  source: Y.Doc;
  plan: PreparedPlan;
  model: AgentEditModel;
  undoClientId?: number;
}): Uint8Array | null {
  const targetSeqs =
    input.direction === "undo" ? input.plan.targetSeqs : redoTargetSeqs(input.plan);
  if (!targetSeqs) return null;
  const reconstructed = reconstructUndoUpdateFromSnapshot(input.plan.snapshot, {
    docId: input.docId,
    targetId: input.targetId,
    targetSeqs,
    undoClientId: input.undoClientId,
  }).undoUpdate;
  return input.direction === "undo"
    ? repairUndoTextOrder({
        source: input.source,
        undoUpdate: reconstructed,
        plan: input.plan,
        model: input.model,
      })
    : reconstructed;
}

function redoTargetSeqs(plan: PreparedPlan): ReadonlySet<number> | null {
  const undoUpdateSeq = plan.redoGroup?.undoUpdateSeq;
  return undoUpdateSeq === undefined ? null : new Set([undoUpdateSeq]);
}

function repairUndoTextOrder(input: {
  source: Y.Doc;
  undoUpdate: Uint8Array;
  plan: PreparedPlan;
  model: AgentEditModel;
}): Uint8Array {
  const targetSeqs = [...input.plan.targetSeqs].sort((left, right) => left - right);
  const firstTargetSeq = targetSeqs[0];
  const lastTargetSeq = targetSeqs.at(-1);
  if (firstTargetSeq === undefined || lastTargetSeq === undefined) return input.undoUpdate;

  const base = docFromSnapshot(input.plan, { untilSeqExclusive: firstTargetSeq });
  const target = docFromSnapshot(input.plan, { untilSeqInclusive: lastTargetSeq });
  const repaired = cloneDoc(input.source);
  try {
    Y.applyUpdate(repaired, input.undoUpdate, { type: "system" });
    const beforeRepairState = Y.encodeStateVector(repaired);
    let changed = false;
    for (const repair of textOrderRepairs({
      base,
      target,
      current: input.source,
      repaired,
      model: input.model,
    })) {
      input.model.transact(
        toDocHandle(repaired),
        () =>
          input.model.applyTextEdit(toDocHandle(repaired), repair.block, repair.span, repair.text),
        { type: "system" },
      );
      changed = true;
    }
    return changed
      ? Y.mergeUpdates([input.undoUpdate, Y.encodeStateAsUpdate(repaired, beforeRepairState)])
      : input.undoUpdate;
  } finally {
    base.destroy();
    target.destroy();
    repaired.destroy();
  }
}

function textOrderRepairs(input: {
  base: Y.Doc;
  target: Y.Doc;
  current: Y.Doc;
  repaired: Y.Doc;
  model: AgentEditModel;
}): Array<{
  block: ReturnType<AgentEditModel["getBlocks"]>[number];
  span: { from: number; to: number };
  text: string;
}> {
  const baseBlocks = blockTextMap(input.base, input.model);
  const targetBlocks = blockTextMap(input.target, input.model);
  const currentBlocks = blockTextMap(input.current, input.model);
  const repairedBlocks = blockRefMap(input.repaired, input.model);
  const repairs: Array<{
    block: ReturnType<AgentEditModel["getBlocks"]>[number];
    span: { from: number; to: number };
    text: string;
  }> = [];

  for (const [hash, baseText] of baseBlocks) {
    const targetText = targetBlocks.get(hash);
    const currentText = currentBlocks.get(hash);
    const repairedBlock = repairedBlocks.get(hash);
    if (targetText === undefined || currentText === undefined || !repairedBlock) continue;
    if (input.model.inlineRuns(repairedBlock).length > 1) continue;

    const edit = simpleReplacement(baseText, targetText);
    if (!edit || edit.inserted.length === 0 || edit.deleted.length === 0) continue;
    if (!currentText.startsWith(edit.prefix) || !currentText.endsWith(edit.suffix)) continue;

    const middle = currentText.slice(edit.prefix.length, currentText.length - edit.suffix.length);
    const insertedAt = middle.lastIndexOf(edit.inserted);
    if (insertedAt < 0) continue;
    const expectedText = `${edit.prefix}${middle.slice(0, insertedAt)}${edit.deleted}${middle.slice(
      insertedAt + edit.inserted.length,
    )}${edit.suffix}`;
    const repairedText = input.model.getText(repairedBlock);
    if (repairedText === expectedText) continue;
    repairs.push({
      block: repairedBlock,
      span: { from: 0, to: repairedText.length },
      text: expectedText,
    });
  }

  return repairs;
}

function docFromSnapshot(
  plan: PreparedPlan,
  options: { untilSeqExclusive?: number; untilSeqInclusive?: number },
): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (plan.snapshot.checkpoint) Y.applyUpdate(doc, plan.snapshot.checkpoint);
  for (const update of plan.snapshot.updates) {
    if (options.untilSeqExclusive !== undefined && update.seq >= options.untilSeqExclusive) break;
    if (options.untilSeqInclusive !== undefined && update.seq > options.untilSeqInclusive) break;
    Y.applyUpdate(doc, update.update);
  }
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function blockTextMap(doc: Y.Doc, model: AgentEditModel): Map<string, string> {
  return new Map(
    model
      .getBlocks(toDocHandle(doc))
      .map((block) => [model.getBlockId(block), model.getText(block)]),
  );
}

function blockRefMap(
  doc: Y.Doc,
  model: AgentEditModel,
): Map<string, ReturnType<AgentEditModel["getBlocks"]>[number]> {
  return new Map(
    model.getBlocks(toDocHandle(doc)).map((block) => [model.getBlockId(block), block]),
  );
}

function simpleReplacement(
  before: string,
  after: string,
): { prefix: string; deleted: string; inserted: string; suffix: string } | undefined {
  if (before === after) return undefined;
  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    before[prefixLength] === after[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return {
    prefix: before.slice(0, prefixLength),
    deleted: before.slice(prefixLength, before.length - suffixLength),
    inserted: after.slice(prefixLength, after.length - suffixLength),
    suffix: suffixLength === 0 ? "" : before.slice(before.length - suffixLength),
  };
}
