// Preflight and mutation of resolved inline, whole-block, and structural edits.

import type { ParsedContent } from "@meridian/markup";
import type { Fragment } from "prosemirror-model";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel, InlineTextReplacement } from "../ports/model.js";
import type { ApplyErrorCode, ApplyResult, ApplyTransactionOrigin, ResolvedEdit } from "./types.js";

type Ref = BlockRef;

type PlannedEdit =
  | {
      kind: "textRanges";
      edit: Extract<ResolvedEdit, { kind: "textRanges" }>;
      replacements: InlineTextReplacement[];
      blockId: string;
    }
  | {
      kind: "insert";
      edit: Extract<ResolvedEdit, { kind: "insert" }>;
      parsed: ParsedContent;
    }
  | {
      kind: "delete";
      edit: Extract<ResolvedEdit, { kind: "delete" }>;
      blockId: string;
      removesBlock: boolean;
    }
  | {
      kind: "block";
      edit: Extract<ResolvedEdit, { kind: "block" }>;
      blockId: string;
    };

interface ApplyAccumulator {
  insertedBlocks: string[];
  touchedHashes: Set<string>;
  deletedHashes: Set<string>;
}

type ApplyFailure = Extract<ApplyResult, { ok: false }>;

/** Mutate an agent-local document without rendering; the write owner snapshots and reports. */
export function applyEdits(
  doc: DocHandle,
  model: AgentEditModel,
  edits: ResolvedEdit | readonly ResolvedEdit[],
  origin: ApplyTransactionOrigin,
): ApplyResult {
  const editList = Array.isArray(edits) ? [...edits] : [edits];
  if (editList.length === 0) {
    return applyError("invalid_write", "applyEdits requires at least one edit");
  }

  const turnSafety = validateNoSameTurnTombstones(doc, model, editList);
  if (!turnSafety.ok) return turnSafety;

  const accumulator: ApplyAccumulator = {
    insertedBlocks: [],
    touchedHashes: new Set(),
    deletedHashes: new Set(),
  };

  let committedEdits = 0;
  for (let index = 0; index < editList.length; index += 1) {
    const planned = preflightEdit(doc, model, editList[index]);
    if (!planned.ok) {
      return applyError(planned.code, planned.message, planned.details, { committedEdits });
    }

    try {
      let executionFailure: ApplyFailure | undefined;
      model.transact(
        doc,
        () => {
          executionFailure = executePlan(doc, model, planned.plan, accumulator);
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
    committedEdits += 1;
  }

  return {
    ok: true,
    changedBlocks: model
      .getDocumentBlockIds(doc)
      .filter((hash) => accumulator.touchedHashes.has(hash)),
    deletedBlocks: [...accumulator.deletedHashes],
    insertedBlocks: accumulator.insertedBlocks,
  };
}

function preflightEdit(
  doc: DocHandle,
  model: AgentEditModel,
  edit: ResolvedEdit,
):
  | { ok: true; plan: PlannedEdit }
  | { ok: false; code: ApplyErrorCode; message: string; details?: Record<string, unknown> } {
  switch (edit.kind) {
    case "textRanges":
      return preflightTextRangesEdit(doc, model, edit);
    case "insert":
      return preflightInsert(doc, model, edit);
    case "delete":
      return preflightDelete(doc, model, edit);
    case "block":
      return preflightBlockReplacement(doc, model, edit);
  }
}

function preflightTextRangesEdit(
  doc: DocHandle,
  model: AgentEditModel,
  edit: Extract<ResolvedEdit, { kind: "textRanges" }>,
): ReturnType<typeof preflightEdit> {
  const live = validateLiveBlock(doc, model, edit.block, "target");
  if (!live.ok) return live;
  if (edit.replacements.length === 0) {
    return {
      ok: false,
      code: "invalid_write",
      message: "Text edits require at least one replacement",
    };
  }

  const text = model.getText(edit.block);
  const replacements: InlineTextReplacement[] = [];
  let previousEnd = -1;
  for (const replacement of edit.replacements) {
    const span = { from: replacement.span.start, to: replacement.span.end };
    if (span.from < 0 || span.to < span.from || span.to > text.length || span.from < previousEnd) {
      return {
        ok: false,
        code: "invalid_write",
        message: `Invalid or overlapping text span ${span.from}..${span.to} for block length ${text.length}`,
      };
    }
    const nonInline = findNonInline(replacement.content);
    if (nonInline) {
      return {
        ok: false,
        code: "invalid_write",
        message: `Text edit content must be inline, got ${nonInline}`,
      };
    }
    replacements.push({ span, content: replacement.content });
    previousEnd = span.to;
  }

  return {
    ok: true,
    plan: {
      kind: "textRanges",

      edit,
      replacements,
      blockId: model.getBlockId(edit.block),
    },
  };
}

function preflightBlockReplacement(
  doc: DocHandle,
  model: AgentEditModel,
  edit: Extract<ResolvedEdit, { kind: "block" }>,
): ReturnType<typeof preflightEdit> {
  const live = validateLiveBlock(doc, model, edit.block, "target");
  if (!live.ok) return live;
  const actual = model.getBlockType(edit.block);
  if (actual !== edit.replacement.type.name) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Cannot update ${actual} block with ${edit.replacement.type.name} content`,
    };
  }
  return {
    ok: true,
    plan: { kind: "block", edit, blockId: model.getBlockId(edit.block) },
  };
}

function preflightInsert(
  doc: DocHandle,
  model: AgentEditModel,
  edit: Extract<ResolvedEdit, { kind: "insert" }>,
): ReturnType<typeof preflightEdit> {
  if (edit.after) {
    const live = validateLiveBlock(doc, model, edit.after, "after");
    if (!live.ok) return live;
  }
  if (edit.blocks.length === 0) {
    return {
      ok: false,
      code: "invalid_write",
      message:
        edit.newText.length === 0
          ? "insert requires non-empty content"
          : "insert produced no blocks",
    };
  }
  return { ok: true, plan: { kind: "insert", edit, parsed: { blocks: [...edit.blocks] } } };
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

      edit,
      blockId: model.getBlockId(block),
      removesBlock: model.getBlocks(doc).length > 1,
    },
  };
}

function executePlan(
  doc: DocHandle,
  model: AgentEditModel,
  plan: PlannedEdit,
  accumulator: ApplyAccumulator,
): ApplyFailure | undefined {
  switch (plan.kind) {
    case "textRanges": {
      const applied = model.applyInlineReplacements(doc, plan.edit.block, plan.replacements);
      if (!applied.ok) return applyError(applied.code, applied.message, applied.details);
      accumulator.touchedHashes.add(plan.blockId);
      break;
    }
    case "insert": {
      const inserted = model.insertBlocks(doc, plan.edit.after ?? null, plan.parsed);
      const blockIds = inserted.map((block) => model.getBlockId(block));
      for (const blockId of blockIds) accumulator.touchedHashes.add(blockId);
      accumulator.insertedBlocks.push(...blockIds);
      break;
    }
    case "delete":
      model.deleteBlock(doc, plan.edit.block);
      if (plan.removesBlock) {
        accumulator.deletedHashes.add(plan.blockId);
      } else {
        accumulator.touchedHashes.add(plan.blockId);
      }
      break;
    case "block":
      model.applyBlockReplacement(doc, plan.edit.block, plan.edit.replacement);
      accumulator.touchedHashes.add(plan.blockId);
      break;
  }
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
    case "textRanges":
    case "delete":
    case "block":
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

/** Name of the first top-level node a text edit can't splice into a textblock. */
function findNonInline(content: Fragment): string | undefined {
  let found: string | undefined;
  content.forEach((node) => {
    if (found === undefined && !node.isInline) found = node.type.name;
  });
  return found;
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
