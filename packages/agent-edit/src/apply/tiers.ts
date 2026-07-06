// Three-tier apply path for resolved agent edits.

import type { ParsedContent } from "@meridian/markup";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Span } from "../codec-types.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel, TextRun } from "../ports/model.js";
import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentUpdateInput,
  computeEcho,
  snapshotBlocks,
} from "./echo.js";
import type {
  AgentOrigin,
  AppliedEditSummary,
  ApplyEditsOptions,
  ApplyErrorCode,
  ApplyResult,
  ApplyTransactionOrigin,
  ResolvedEdit,
} from "./types.js";

type Ref = BlockRef;

type PlannedEdit =
  | {
      kind: "text";
      tier: 1;
      edit: Extract<ResolvedEdit, { kind: "text" }>;
      span: Span;
      blockId: string;
    }
  | {
      kind: "text";
      tier: 2;
      edit: Extract<ResolvedEdit, { kind: "text" }>;
      span: Span;
      blockId: string;
    }
  | {
      kind: "insert";
      tier: 3;
      edit: Extract<ResolvedEdit, { kind: "insert" }>;
      parsed: ParsedContent;
    }
  | {
      kind: "delete";
      tier: 3;
      edit: Extract<ResolvedEdit, { kind: "delete" }>;
      blockId: string;
      removesBlock: boolean;
    };

interface ApplyAccumulator {
  applied: AppliedEditSummary[];
  touchedHashes: Set<string>;
  deletedHashes: Set<string>;
}

type ApplyFailure = Extract<ApplyResult, { ok: false }>;

/** Apply resolved edits to an agent-local document using the three-tier mutation plan. */
export function applyEdits(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edits: ResolvedEdit | readonly ResolvedEdit[],
  origin: ApplyTransactionOrigin,
  options: ApplyEditsOptions = {},
): ApplyResult {
  const editList = Array.isArray(edits) ? [...edits] : [edits];
  if (editList.length === 0)
    return applyError("invalid_write", "applyEdits requires at least one edit");

  const turnSafety = validateNoSameTurnTombstones(doc, model, editList);
  if (!turnSafety.ok) return turnSafety;

  const before = snapshotBlocks(doc, model, codec);
  const accumulator: ApplyAccumulator = {
    applied: [],
    touchedHashes: new Set(),
    deletedHashes: new Set(),
  };

  let committedEdits = 0;
  for (let index = 0; index < editList.length; index += 1) {
    const planned = preflightEdit(doc, model, codec, editList[index]);
    if (!planned.ok) {
      return applyError(planned.code, planned.message, planned.details, { committedEdits });
    }

    const group = collectTierOneGroup(doc, model, codec, editList, index, planned.plan);
    if (!group.ok) {
      return applyError(group.code, group.message, group.details, { committedEdits });
    }

    try {
      let executionFailure: ApplyFailure | undefined;
      model.transact(
        doc,
        () => {
          executionFailure = executePlans(doc, model, codec, group.plans, accumulator);
        },
        origin,
      );
      if (executionFailure) return executionFailure;
    } catch (cause) {
      return applyError(
        "partial_failure",
        cause instanceof Error ? cause.message : String(cause),
        { failedAt: index },
        { committedEdits },
      );
    }
    committedEdits += group.plans.length;
    index += group.plans.length - 1;
  }

  const concurrent = applyConcurrentUpdates(
    doc,
    model,
    codec,
    (options.concurrentUpdates ?? []) as readonly ConcurrentUpdateInput[],
    ownAgentOrigin(origin, options.ownActorTurnId),
    options.concurrentCollapseThreshold,
  );
  const after = snapshotBlocks(doc, model, codec);
  const echo = computeEcho({
    before,
    after,
    agentTouchedHashes: accumulator.touchedHashes,
    agentDeletedHashes: accumulator.deletedHashes,
  });

  return {
    ok: true,
    status: "success",
    documentId: editList[0]?.documentId ?? "",
    file: editList[0]?.file ?? "",
    echo,
    ...(concurrent.info ? { concurrentEdits: concurrent.info } : {}),
    changedBlocks: orderedLiveHashes(after, accumulator.touchedHashes),
    deletedBlocks: [...accumulator.deletedHashes],
    appliedEdits: accumulator.applied,
  };
}

function ownAgentOrigin(
  origin: ApplyTransactionOrigin,
  ownActorTurnId: string | undefined,
): AgentOrigin | undefined {
  if (ownActorTurnId) return { type: "agent", actorTurnId: ownActorTurnId };
  if (isAgentOrigin(origin)) return origin;
  return undefined;
}

function isAgentOrigin(origin: ApplyTransactionOrigin): origin is AgentOrigin {
  return (
    typeof origin === "object" &&
    origin !== null &&
    (origin as { type?: unknown }).type === "agent" &&
    typeof (origin as { actorTurnId?: unknown }).actorTurnId === "string"
  );
}

function preflightEdit(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edit: ResolvedEdit,
):
  | { ok: true; plan: PlannedEdit }
  | { ok: false; code: ApplyErrorCode; message: string; details?: Record<string, unknown> } {
  switch (edit.kind) {
    case "text":
      return preflightTextEdit(doc, model, codec, edit);
    case "insert":
      return preflightInsert(doc, model, codec, edit);
    case "delete":
      return preflightDelete(doc, model, edit);
  }
}

function preflightTextEdit(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edit: Extract<ResolvedEdit, { kind: "text" }>,
): ReturnType<typeof preflightEdit> {
  const live = validateLiveBlock(doc, model, edit.block, "target");
  if (!live.ok) return live;
  const span = { from: edit.span.start, to: edit.span.end };
  const block = edit.block;
  const text = model.getText(block);
  if (span.from < 0 || span.to < span.from || span.to > text.length) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Invalid text span ${span.from}..${span.to} for block length ${text.length}`,
    };
  }

  const parsed = parseContent(codec, edit.newText, "text");
  if (!parsed.ok) return parsed;

  const sameMarkContext = spanWithinSingleMarkContext(model.inlineRuns(edit.block), span);
  if (sameMarkContext && model.isPlainTextReplacement(parsed.parsed, edit.newText)) {
    return {
      ok: true,
      plan: { kind: "text", tier: 1, edit, span, blockId: model.getBlockId(block) },
    };
  }

  return {
    ok: true,
    plan: { kind: "text", tier: 2, edit, span, blockId: model.getBlockId(block) },
  };
}

function preflightInsert(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edit: Extract<ResolvedEdit, { kind: "insert" }>,
): ReturnType<typeof preflightEdit> {
  if (edit.after) {
    const live = validateLiveBlock(doc, model, edit.after, "after");
    if (!live.ok) return live;
  }
  if (edit.newText.length === 0) {
    return { ok: false, code: "invalid_write", message: "insert requires non-empty content" };
  }
  const parsed = parseContent(codec, edit.newText, "insert");
  if (!parsed.ok) return parsed;
  if (parsed.parsed.blocks.length === 0) {
    return { ok: false, code: "invalid_write", message: "insert produced no blocks" };
  }
  return { ok: true, plan: { kind: "insert", tier: 3, edit, parsed: parsed.parsed } };
}

function preflightDelete(
  doc: DocHandle,
  model: AgentEditModel,
  edit: Extract<ResolvedEdit, { kind: "delete" }>,
): ReturnType<typeof preflightEdit> {
  const live = validateLiveBlock(doc, model, edit.block, "target");
  if (!live.ok) return live;
  const block = edit.block;
  return {
    ok: true,
    plan: {
      kind: "delete",
      tier: 3,
      edit,
      blockId: model.getBlockId(block),
      removesBlock: model.getBlocks(doc).length > 1,
    },
  };
}

function executePlans(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  plans: readonly PlannedEdit[],
  accumulator: ApplyAccumulator,
): ApplyFailure | undefined {
  const ordered = [...plans].sort((left, right) => {
    if (left.kind !== "text" || right.kind !== "text") return 0;
    if (left.edit.block !== right.edit.block) return 0;
    return textPlanStart(right) - textPlanStart(left);
  });

  for (const plan of ordered) {
    switch (plan.kind) {
      case "text":
        if (plan.tier === 1) {
          model.applyTextEdit(doc, plan.edit.block, plan.span, plan.edit.newText);
        } else {
          const applied = model.applyInlineReplacement(
            doc,
            plan.edit.block,
            plan.span,
            plan.edit.newText,
            codec,
          );
          if (!applied.ok) return applyError(applied.code, applied.message, applied.details);
        }
        accumulator.touchedHashes.add(plan.blockId);
        accumulator.applied.push({ kind: "text", tier: plan.tier, blockIds: [plan.blockId] });
        break;
      case "insert": {
        const inserted = model.insertBlocks(doc, plan.edit.after ?? null, plan.parsed);
        const blockIds = inserted.map((block) => model.getBlockId(block));
        for (const blockId of blockIds) accumulator.touchedHashes.add(blockId);
        accumulator.applied.push({ kind: "insert", tier: 3, blockIds });
        break;
      }
      case "delete":
        model.deleteBlock(doc, plan.edit.block);
        if (plan.removesBlock) {
          accumulator.deletedHashes.add(plan.blockId);
        } else {
          accumulator.touchedHashes.add(plan.blockId);
        }
        accumulator.applied.push({ kind: "delete", tier: 3, blockIds: [plan.blockId] });
        break;
    }
  }
}

function textPlanStart(plan: Extract<PlannedEdit, { kind: "text" }>): number {
  return plan.tier === 1 ? plan.span.from : plan.edit.span.start;
}

function collectTierOneGroup(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edits: readonly ResolvedEdit[],
  startIndex: number,
  firstPlan: PlannedEdit,
):
  | { ok: true; plans: PlannedEdit[] }
  | { ok: false; code: ApplyErrorCode; message: string; details?: Record<string, unknown> } {
  if (firstPlan.kind !== "text" || firstPlan.tier !== 1) return { ok: true, plans: [firstPlan] };
  const plans: PlannedEdit[] = [firstPlan];
  let previousEnd = firstPlan.span.to;

  for (let index = startIndex + 1; index < edits.length; index += 1) {
    const candidate = edits[index];
    if (candidate.kind !== "text" || candidate.block !== firstPlan.edit.block) break;
    const planned = preflightEdit(doc, model, codec, candidate);
    if (!planned.ok) return planned;
    if (planned.plan.kind !== "text" || planned.plan.tier !== 1) break;
    if (candidate.span.start < previousEnd) break;
    plans.push(planned.plan);
    previousEnd = planned.plan.span.to;
  }

  return { ok: true, plans };
}

function validateNoSameTurnTombstones(
  doc: DocHandle,
  model: AgentEditModel,
  edits: readonly ResolvedEdit[],
): { ok: true } | ApplyFailure {
  const shadowBlocks = [...model.getBlocks(doc)];
  const removed = new Set<Ref>();

  for (const edit of edits) {
    const refs = referencedElements(edit);
    for (const ref of refs) {
      if (removed.has(ref)) {
        return applyError("not_found", "Target block was removed earlier in this turn");
      }
      if (!model.isLive(ref) || !shadowBlocks.includes(ref)) {
        return applyError("not_found", "Target block is no longer live in this document");
      }
    }
    if (edit.kind === "delete" && shadowBlocks.length > 1) {
      removed.add(edit.block);
      shadowBlocks.splice(shadowBlocks.indexOf(edit.block), 1);
    }
    if (edit.kind === "insert") {
      // Inserts create fresh blocks only at execution time; the shadow pass only
      // needs to validate that later commands do not target already-deleted refs.
    }
  }
  return { ok: true };
}

function referencedElements(edit: ResolvedEdit): Ref[] {
  switch (edit.kind) {
    case "text":
    case "delete":
      return [edit.block];
    case "insert":
      return edit.after ? [edit.after] : [];
  }
}

function validateLiveBlock(
  doc: DocHandle,
  model: AgentEditModel,
  block: Ref,
  label: string,
): { ok: true } | { ok: false; code: ApplyErrorCode; message: string } {
  if (!model.isLive(block) || !model.getBlocks(doc).includes(block)) {
    return { ok: false, code: "not_found", message: `${label} block is no longer live` };
  }
  return { ok: true };
}

function parseContent(
  codec: AgentEditCodec,
  content: string,
  operation: "text" | "insert",
):
  | { ok: true; parsed: ParsedContent }
  | { ok: false; code: ApplyErrorCode; message: string; details?: Record<string, unknown> } {
  if (operation === "text" && content.length === 0) return { ok: true, parsed: { blocks: [] } };
  try {
    return { ok: true, parsed: codec.parse(content) };
  } catch (cause) {
    const record = cause instanceof Error ? cause : undefined;
    const details: Record<string, unknown> = {};
    const line = (cause as { line?: unknown } | null)?.line;
    const column = (cause as { column?: unknown } | null)?.column;
    if (typeof line === "number") details.line = line;
    if (typeof column === "number") details.column = column;
    return {
      ok: false,
      code: "invalid_write",
      message: record?.message ?? String(cause),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  }
}

function spanWithinSingleMarkContext(runs: readonly TextRun[], span: Span): boolean {
  if (span.from === span.to) return insertionPointHasContext(runs, span.from);
  const covered = runs.filter((run) => span.from < run.start + run.length && span.to > run.start);
  if (covered.length === 0) return false;
  const firstKey = covered[0]?.attrsKey;
  return covered.every((run) => run.attrsKey === firstKey);
}

function insertionPointHasContext(runs: readonly TextRun[], offset: number): boolean {
  if (runs.length === 0) return offset === 0;
  return runs.some((run) => offset >= run.start && offset <= run.start + run.length);
}

function orderedLiveHashes(after: readonly BlockSnapshot[], hashes: ReadonlySet<string>): string[] {
  return after.map((block) => block.hash).filter((hash) => hashes.has(hash));
}

function applyError(
  code: ApplyErrorCode,
  message: string,
  details?: Record<string, unknown>,
  extra?: { committedEdits?: number },
): ApplyFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(extra?.committedEdits !== undefined ? { committedEdits: extra.committedEdits } : {}),
    },
  };
}
