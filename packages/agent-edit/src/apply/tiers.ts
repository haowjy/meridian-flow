// Three-tier Yjs apply path for resolved agent edits.

import type { ParsedContent } from "@meridian/markup";
import type { Node as PMNode } from "prosemirror-model";
import { Fragment } from "prosemirror-model";
import * as Y from "yjs";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Span } from "../codec-types.js";
import type { AgentEditModel } from "../ports/model.js";
import { isLiveXmlElement } from "../resolver/block-hash.js";
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

interface TextRun {
  start: number;
  length: number;
  attrsKey: string;
}

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
      replacement: PMNode;
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

/** Apply resolved edits to an agent-local Y.Doc using the three-tier mutation plan. */
export function applyEdits(
  doc: Y.Doc,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edits: ResolvedEdit | readonly ResolvedEdit[],
  origin: ApplyTransactionOrigin,
  options: ApplyEditsOptions = {},
): ApplyResult {
  const editList = Array.isArray(edits) ? [...edits] : [edits];
  if (editList.length === 0)
    return applyError("invalid_write", "applyEdits requires at least one edit");

  const beforeApplyStateVector = options.syncStateVector ?? Y.encodeStateVector(doc);
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
      doc.transact(() => executePlans(doc, model, group.plans, accumulator), origin);
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
    options.syncStateVector ?? beforeApplyStateVector,
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
  doc: Y.Doc,
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
  doc: Y.Doc,
  model: AgentEditModel,
  codec: AgentEditCodec,
  edit: Extract<ResolvedEdit, { kind: "text" }>,
): ReturnType<typeof preflightEdit> {
  const live = validateLiveBlock(doc, model, edit.element, "target");
  if (!live.ok) return live;
  const span = { from: edit.span.start, to: edit.span.end };
  const text = model.getText(edit.element);
  if (span.from < 0 || span.to < span.from || span.to > text.length) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Invalid text span ${span.from}..${span.to} for block length ${text.length}`,
    };
  }

  const parsed = parseContent(codec, edit.newText, "text");
  if (!parsed.ok) return parsed;

  const pmBlock = model.toProsemirrorBlock(doc, edit.element);
  if (pmBlock.type.name !== edit.element.nodeName) {
    return blockTypeMismatch(edit.element.nodeName, pmBlock.type.name);
  }

  const sameMarkContext = spanWithinSingleMarkContext(collectTextRuns(edit.element), span);
  if (sameMarkContext && isPlainTextReplacement(parsed.parsed, edit.newText)) {
    return {
      ok: true,
      plan: { kind: "text", tier: 1, edit, span, blockId: model.getBlockId(edit.element) },
    };
  }

  const inline = inlineReplacement(parsed.parsed);
  if (!inline.ok) return inline;
  if (!canReplaceInline(pmBlock)) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Text edits with formatting are not supported for ${pmBlock.type.name} blocks`,
    };
  }
  const replacement = replaceFlatText(pmBlock, span, inline.nodes);
  if (replacement.type.name !== edit.element.nodeName) {
    return blockTypeMismatch(edit.element.nodeName, replacement.type.name);
  }
  return {
    ok: true,
    plan: { kind: "text", tier: 2, edit, replacement, blockId: model.getBlockId(edit.element) },
  };
}

function preflightInsert(
  doc: Y.Doc,
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
  doc: Y.Doc,
  model: AgentEditModel,
  edit: Extract<ResolvedEdit, { kind: "delete" }>,
): ReturnType<typeof preflightEdit> {
  const live = validateLiveBlock(doc, model, edit.element, "target");
  if (!live.ok) return live;
  const pmBlock = model.toProsemirrorBlock(doc, edit.element);
  if (pmBlock.type.name !== edit.element.nodeName) {
    return blockTypeMismatch(edit.element.nodeName, pmBlock.type.name);
  }
  return {
    ok: true,
    plan: {
      kind: "delete",
      tier: 3,
      edit,
      blockId: model.getBlockId(edit.element),
      removesBlock: model.getBlocks(doc).length > 1,
    },
  };
}

function executePlans(
  doc: Y.Doc,
  model: AgentEditModel,
  plans: readonly PlannedEdit[],
  accumulator: ApplyAccumulator,
): void {
  const ordered = [...plans].sort((left, right) => {
    if (left.kind !== "text" || right.kind !== "text") return 0;
    if (left.edit.element !== right.edit.element) return 0;
    return textPlanStart(right) - textPlanStart(left);
  });

  for (const plan of ordered) {
    switch (plan.kind) {
      case "text":
        if (plan.tier === 1) {
          model.applyTextEdit(doc, plan.edit.element, plan.span, plan.edit.newText);
        } else {
          model.applyBlockDiff(doc, plan.edit.element, plan.replacement);
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
        model.deleteBlock(doc, plan.edit.element);
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
  doc: Y.Doc,
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
    if (candidate.kind !== "text" || candidate.element !== firstPlan.edit.element) break;
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
  doc: Y.Doc,
  model: AgentEditModel,
  edits: readonly ResolvedEdit[],
): { ok: true } | ApplyFailure {
  const shadowBlocks = [...model.getBlocks(doc)];
  const removed = new Set<Y.XmlElement>();

  for (const edit of edits) {
    const refs = referencedElements(edit);
    for (const ref of refs) {
      if (removed.has(ref)) {
        return applyError("not_found", "Target block was removed earlier in this turn");
      }
      if (!isLiveXmlElement(ref) || !shadowBlocks.includes(ref)) {
        return applyError("not_found", "Target block is no longer live in this document");
      }
    }
    if (edit.kind === "delete" && shadowBlocks.length > 1) {
      removed.add(edit.element);
      shadowBlocks.splice(shadowBlocks.indexOf(edit.element), 1);
    }
    if (edit.kind === "insert") {
      // Inserts create fresh blocks only at execution time; the shadow pass only
      // needs to validate that later commands do not target already-deleted refs.
    }
  }
  return { ok: true };
}

function referencedElements(edit: ResolvedEdit): Y.XmlElement[] {
  switch (edit.kind) {
    case "text":
    case "delete":
      return [edit.element];
    case "insert":
      return edit.after ? [edit.after] : [];
  }
}

function validateLiveBlock(
  doc: Y.Doc,
  model: AgentEditModel,
  block: Y.XmlElement,
  label: string,
): { ok: true } | { ok: false; code: ApplyErrorCode; message: string } {
  if (!isLiveXmlElement(block) || !model.getBlocks(doc).includes(block)) {
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

function isPlainTextReplacement(parsed: ParsedContent, source: string): boolean {
  if (source.length === 0) return true;
  if (parsed.blocks.length !== 1) return false;
  const block = parsed.blocks[0];
  if (!block?.isTextblock) return false;
  if (block.textContent !== source) return false;
  let plain = true;
  block.descendants((node) => {
    if (node.isText) {
      if (node.marks.length > 0) plain = false;
      return false;
    }
    if (node.type.name !== "hard_break") plain = false;
    return !plain;
  });
  return plain;
}

function inlineReplacement(
  parsed: ParsedContent,
): { ok: true; nodes: PMNode[] } | { ok: false; code: ApplyErrorCode; message: string } {
  if (parsed.blocks.length === 0) return { ok: true, nodes: [] };
  if (parsed.blocks.length !== 1) {
    return {
      ok: false,
      code: "invalid_write",
      message: "Text edits cannot introduce multiple blocks; use an insert/delete structural edit",
    };
  }
  const block = parsed.blocks[0];
  if (!block?.isTextblock) {
    return {
      ok: false,
      code: "invalid_write",
      message: `Text edit content must parse to inline text, got ${block?.type.name ?? "nothing"}`,
    };
  }
  const nodes: PMNode[] = [];
  block.forEach((child) => {
    nodes.push(child);
  });
  return { ok: true, nodes };
}

function canReplaceInline(block: PMNode): boolean {
  return block.isTextblock && block.type.name !== "code_block";
}

function replaceFlatText(block: PMNode, span: Span, replacement: readonly PMNode[]): PMNode {
  let cursor = 0;
  let inserted = false;
  const children: PMNode[] = [];

  const insertReplacement = () => {
    if (inserted) return;
    children.push(...replacement);
    inserted = true;
  };

  block.forEach((child) => {
    if (!child.isText) {
      if (cursor >= span.from && cursor <= span.to) insertReplacement();
      children.push(child);
      return;
    }
    const text = child.text ?? "";
    const start = cursor;
    const end = cursor + text.length;
    if (end <= span.from || start >= span.to) {
      if (!inserted && span.from === span.to && span.from === start) insertReplacement();
      children.push(child);
      cursor = end;
      return;
    }

    const keepLeft = Math.max(0, span.from - start);
    const keepRight = Math.max(0, end - span.to);
    if (keepLeft > 0) children.push(child.type.schema.text(text.slice(0, keepLeft), child.marks));
    insertReplacement();
    if (keepRight > 0)
      children.push(child.type.schema.text(text.slice(text.length - keepRight), child.marks));
    cursor = end;
  });
  if (!inserted) insertReplacement();

  return block.type.create(block.attrs, Fragment.from(children), block.marks);
}

function collectTextRuns(block: Y.XmlElement): TextRun[] {
  const runs: TextRun[] = [];
  let flatOffset = 0;
  const visit = (type: Y.XmlElement | Y.XmlText) => {
    if (type instanceof Y.XmlText) {
      for (const delta of type.toDelta() as Array<{
        insert?: string;
        attributes?: Record<string, unknown>;
      }>) {
        const text = typeof delta.insert === "string" ? delta.insert : "";
        const length = text.length;
        if (length > 0) {
          runs.push({
            start: flatOffset,
            length,
            attrsKey: stableAttrsKey(delta.attributes),
          });
          flatOffset += length;
        }
      }
      return;
    }
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(block);
  return runs;
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

function stableAttrsKey(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return "";
  return JSON.stringify(sortRecord(attrs));
}

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecord);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortRecord(nested)]),
  );
}

function blockTypeMismatch(
  actual: string,
  expected: string,
): { ok: false; code: ApplyErrorCode; message: string; details: Record<string, unknown> } {
  return {
    ok: false,
    code: "not_found",
    message: `Block type changed from ${actual} to ${expected}; re-view before writing`,
    details: { actual, expected },
  };
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
