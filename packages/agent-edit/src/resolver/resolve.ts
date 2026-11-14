import { CodecParseError, type ParsedContent, type ParsedContentWithSpans } from "@meridian/markup";
import type { EditResolutionErrorCode, ResolvedEdit } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import type { DocumentAddress } from "../document-address.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { LineageRange } from "../lineage/range-set.js";
import { normalizeLineageRanges } from "../lineage/range-set.js";
import type { WriteLinkAssigner } from "../links/assign-refs.js";
import type { AgentEditModel } from "../ports/model.js";
import type { SemanticEditIRV1, SemanticOutputRun } from "../semantic-edit-ir.js";
import { alignBlocks } from "./block-alignment.js";
import {
  cutTextWindows,
  findTextMatches,
  type SplicedGroup,
  spliceFindMatches,
  type TextFindMatch,
  type TextWindow,
} from "./find.js";
import { type HashLocateContext, hashLocateContext, locateBlockByHash } from "./hash-locator.js";
import { lowerBlock } from "./lower-block.js";
import {
  type BlockScope,
  resolveScope,
  resolveSearchScope,
  type ScopeFailure,
  type ScopeResult,
} from "./scope.js";

export type WriteCommandName = "insert" | "replace" | "remove";

export interface ResolveWriteParams {
  documentAddress: DocumentAddress;
  command: WriteCommandName;
  content?: string;
  /** Already-parsed content, with the original source retained in `content` for semantic IR. */
  parsedContent?: ParsedContent;
  /**
   * Blocks copied from another document. They take the place of
   * `content` and are inserted as nodes, never through markup.
   */
  blocks?: readonly Block[];
  after?: string;
  before?: string;
  find?: string;
  in?: unknown;
  around?: string;
  all?: boolean;
  /** Target every block of the document, whatever its repaired size turns out to be (`in` is ignored). */
  wholeDocument?: boolean;
}

export interface ResolveWriteContext {
  doc: DocHandle | null | undefined;
  model: AgentEditModel;
  codec: AgentEditCodec;
  /**
   * Ref assignment over the command's prepared link scope; parse itself is
   * pure syntax. Every door that turns written Markdown into nodes assigns
   * through it before block alignment and no-op detection. Copies never do:
   * their nodes already carry what they name. `"preassigned"`: the caller
   * already assigned refs (a host's lowered overwrite), so nodes stay as given.
   */
  links: WriteLinks;
  /** Exact revision whose live block handles and source ranges the resolver inspects. */
  inputRevision?: string;
}

/** Ref assignment for a write, or `"preassigned"` for nodes whose refs are already assigned. */
export type WriteLinks = WriteLinkAssigner | "preassigned";

export type ResolveWriteResult =
  | {
      ok: true;
      edits: ResolvedEdit[];
      ir: SemanticEditIRV1;
    }
  | {
      ok: false;
      error: {
        code: EditResolutionErrorCode;
        message: string;
        details?: Record<string, unknown>;
      };
    };

type ResolveWriteFailure = Extract<ResolveWriteResult, { ok: false }>;

interface NormalizedParams extends ResolveWriteParams {
  content: string;
}

/**
 * A write resolved up to ref assignment: scope, find matches and splices are fixed,
 * and `written` holds every parsed node assignment will see (a find's
 * reconstructed groups included), so the host can load what they name
 * before `assign` runs synchronously over the prepared scope.
 */
export type WritePlan =
  | {
      ok: true;
      written: readonly Block[];
      /** Ref assignment, then block alignment and no-op detection. */
      assign(links: WriteLinks): ResolveWriteResult;
    }
  | ResolveWriteFailure;

export function planWrite(
  ctx: Omit<ResolveWriteContext, "links">,
  params: ResolveWriteParams,
): WritePlan {
  if (!ctx.doc)
    return error("document_not_found", `File not found: ${params.documentAddress.filePath}`);
  const doc = ctx.doc;
  // Projecting repairs the document (an element the schema can't build is deleted), so it
  // runs before anything takes an index; every scope, hash lookup and anchor below reads
  // this one list. The resolver does not change the document, so it stays current.
  const projected = ctx.model.projectBlocks(doc);
  const concreteCtx: ConcreteResolveContext = {
    ...hashLocateContext(ctx.model, projected),
    ...ctx,
    doc,
  };
  const normalized = normalizeParams(concreteCtx, params);
  const contentCheck = validateContent(concreteCtx, normalized);
  if (!contentCheck.ok) return contentCheck;

  let planned: PlannedWrite | ResolveWriteFailure;
  switch (normalized.command) {
    case "insert":
      planned = planInsert(concreteCtx, normalized, contentCheck.parsed);
      break;
    case "replace":
      planned = planReplace(concreteCtx, normalized, contentCheck.parsed);
      break;
    case "remove":
      planned = planRemove(concreteCtx, normalized);
      break;
  }
  if (!("steps" in planned)) return planned;
  const steps = planned.steps;
  return {
    ok: true,
    written: steps.flatMap((step) =>
      step.kind === "spliced"
        ? step.parsed.blocks
        : step.kind === "edits" || (step.kind === "insert" && !step.assign)
          ? []
          : step.blocks,
    ),
    assign(links) {
      const resolved = assignPlannedWrite(concreteCtx, normalized, steps, links);
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        edits: resolved.edits,
        ir: semanticIrForResolvedEdits(concreteCtx, normalized, resolved),
      };
    },
  };
}

/** Plan and assign in one go, for callers whose written content is known up front. */
export function resolveWrite(
  ctx: ResolveWriteContext,
  params: ResolveWriteParams,
): ResolveWriteResult {
  const plan = planWrite(ctx, params);
  return plan.ok ? plan.assign(ctx.links) : plan;
}

/** One planned piece of a write, in edit order. */
type PlannedStep =
  /** Edits that need no ref assignment: removes and copies. */
  | { kind: "edits"; edits: ResolvedEdit[] }
  | { kind: "insert"; after: BlockRef | undefined; blocks: Block[]; assign: boolean }
  /** Rewrite `scope` as `blocks`, assigned against the scope's old nodes. */
  | { kind: "replace"; scope: BlockScope; blocks: Block[] }
  /** A find's reconstructed group: only the splice's occurrences are assigned. */
  | {
      kind: "spliced";
      scope: BlockScope;
      oldGroup: Block[];
      oldText: string;
      oldSpans: ParsedContentWithSpans["spans"];
      newText: string;
      parsed: ParsedContentWithSpans;
      splice: SplicedGroup["splice"];
      /** Each block's text windows the find's cuts cover, old and new; null when unmappable. */
      windows: CutWindows | null;
    };

interface CutWindows {
  old: TextWindow[][];
  new: TextWindow[][];
}

interface PlannedWrite {
  steps: PlannedStep[];
}

function assignPlannedWrite(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  steps: readonly PlannedStep[],
  links: WriteLinks,
): ResolveWriteResultWithoutIr {
  const edits: ResolvedEdit[] = [];
  let keptBlocks = false;
  for (const step of steps) {
    switch (step.kind) {
      case "edits":
        edits.push(...step.edits);
        break;
      case "insert": {
        const blocks = step.assign ? assignSpan(links, [], step.blocks) : step.blocks;
        edits.push(insertEdit(params, step.after, blocks));
        break;
      }
      case "replace":
      case "spliced": {
        const lowered = replaceScope(
          ctx,
          params,
          step.scope,
          assignScope(ctx, step, links),
          step.kind === "spliced" ? step.windows : null,
        );
        edits.push(...lowered.edits);
        keptBlocks ||= lowered.keptBlocks === true;
        break;
      }
    }
  }
  return { ok: true, edits, ...(keptBlocks ? { keptBlocks: true } : {}) };
}

interface LoweredScope {
  edits: ResolvedEdit[];
  /** Some of the scope's blocks were already equal to their replacement and kept. */
  keptBlocks?: true;
}

/** Assigned before alignment, so an unchanged block stays `.eq` and is kept. */
function assignScope(
  ctx: ConcreteResolveContext,
  step: Extract<PlannedStep, { kind: "replace" | "spliced" }>,
  links: WriteLinks,
): Block[] {
  if (step.kind === "replace") return assignSpan(links, scopeNodes(ctx, step.scope), step.blocks);
  if (links === "preassigned") return step.parsed.blocks;
  return links.assignSplice({
    oldGroup: step.oldGroup,
    oldText: step.oldText,
    oldSpans: step.oldSpans,
    newText: step.newText,
    parsed: step.parsed,
    splice: step.splice,
  });
}

/** A scope is always a contiguous run of top-level blocks. */
function scopeNodes(ctx: ConcreteResolveContext, scope: BlockScope): Block[] {
  return ctx.projected
    .slice(scope.startIndex, scope.startIndex + scope.blocks.length)
    .map((block) => block.node);
}

type ResolveWriteResultWithoutIr = ({ ok: true } & LoweredScope) | ResolveWriteFailure;

function planInsert(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): PlannedWrite | ResolveWriteFailure {
  const sectionCheck = validateSectionContent(ctx, params, parsed);
  if (!sectionCheck.ok) return sectionCheck;

  if (params.find !== undefined) {
    if (params.blocks) return error("invalid_write", COPY_WITH_FIND_MESSAGE);
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around, {
      allowSlugFallback: false,
    });
    if (!scope.ok) return scopeError(scope);
    const found = findTextMatches(ctx, scope.scope, params.find, params.all === true);
    if (!found.ok) return findError(found);
    return planFindMatches(ctx, params, found.matches, "insert");
  }

  const lowered = lowerInsertPosition(ctx, params);
  if (!lowered.ok) return lowered;
  return {
    steps: [
      { kind: "insert", after: lowered.after, blocks: parsed.blocks, assign: !params.blocks },
    ],
  };
}

const COPY_WITH_FIND_MESSAGE = "from copies whole blocks, so it can't be combined with find";

function insertEdit(
  params: NormalizedParams,
  after: BlockRef | undefined,
  blocks: readonly Block[],
  newText = params.content,
): Extract<ResolvedEdit, { kind: "insert" }> {
  return {
    documentId: params.documentAddress.documentId,
    file: params.documentAddress.filePath,
    kind: "insert",
    ...(after ? { after } : {}),
    newText,
    blocks,
  };
}

/**
 * Copied blocks replace the scope whole: they go in after the block before it,
 * then the scope's blocks go. No old block is reused, so every copy gets a
 * fresh hash and none of the replaced text survives under a copied block.
 */
function replaceScopeWithCopies(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  scope: BlockScope,
  copies: readonly Block[],
): PlannedWrite {
  const anchor = scope.startIndex > 0 ? ctx.projected[scope.startIndex - 1]?.ref : undefined;
  return {
    steps: [
      { kind: "edits", edits: [insertEdit(params, anchor, copies), ...deleteEdits(params, scope)] },
    ],
  };
}

function planReplace(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): PlannedWrite | ResolveWriteFailure {
  const sectionCheck = validateSectionContent(ctx, params, parsed);
  if (!sectionCheck.ok) return sectionCheck;

  if (params.find !== undefined) {
    if (params.blocks) return error("invalid_write", COPY_WITH_FIND_MESSAGE);
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around, {
      allowSlugFallback: false,
    });
    if (!scope.ok) return scopeError(scope);
    const found = findTextMatches(ctx, scope.scope, params.find, params.all === true);
    if (!found.ok) return findError(found);
    return planFindMatches(ctx, params, found.matches, "replace");
  }

  const target = params.in ?? fragmentScope(params);
  if (target === undefined && !params.wholeDocument) {
    return error("invalid_write", "replace needs `in`, `find` or a #heading-slug in path");
  }
  const scope = writeScope(ctx, params, target);
  if (!scope.ok) return scopeError(scope);
  if (params.blocks) {
    if (params.blocks.length === 0) return error("invalid_write", "from selected no blocks");
    return replaceScopeWithCopies(ctx, params, scope.scope, params.blocks);
  }
  if (params.content.length === 0) {
    return error("invalid_write", "Use `remove` to remove blocks");
  }
  return { steps: [{ kind: "replace", scope: scope.scope, blocks: parsed.blocks }] };
}

function planRemove(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): PlannedWrite | ResolveWriteFailure {
  const scope = writeScope(ctx, params, params.in ?? fragmentScope(params));
  if (!scope.ok) return scopeError(scope);
  return { steps: [{ kind: "edits", edits: deleteEdits(params, scope.scope) }] };
}

/** The blocks a replace or remove targets; a whole-document write takes the repaired document's. */
function writeScope(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  target: unknown,
): ScopeResult {
  return params.wholeDocument
    ? resolveSearchScope(ctx)
    : resolveScope(ctx, target, { allowSlugFallback: false });
}

interface ConcreteResolveContext
  extends Omit<ResolveWriteContext, "links">,
    Omit<HashLocateContext, "model"> {
  doc: DocHandle;
}

function normalizeParams(
  ctx: ConcreteResolveContext,
  params: ResolveWriteParams,
): NormalizedParams {
  // Copied blocks are described by their markup only for the semantic IR.
  const content = params.blocks
    ? serializeReplacementBlocks(ctx, [...params.blocks])
    : (params.content ?? "");
  return { ...params, content };
}

function assignSpan(links: WriteLinks, old: readonly Block[], written: readonly Block[]): Block[] {
  return links === "preassigned" ? [...written] : links.assignSpan(old, written);
}

function validateContent(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): ResolveWriteFailure | { ok: true; parsed: ParsedContent } {
  if (params.blocks) return { ok: true, parsed: { blocks: [...params.blocks] } };
  if (params.command === "replace" && params.content.length === 0) {
    return { ok: true, parsed: { blocks: [] } };
  }
  if (params.command === "remove") return { ok: true, parsed: { blocks: [] } };
  if (params.parsedContent) return { ok: true, parsed: params.parsedContent };
  try {
    return { ok: true, parsed: ctx.codec.parse(params.content) };
  } catch (cause) {
    if (cause instanceof CodecParseError) {
      return error("invalid_write", cause.message, { line: cause.line, column: cause.column });
    }
    return error("invalid_write", cause instanceof Error ? cause.message : String(cause));
  }
}

function validateSectionContent(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): ResolveWriteFailure | { ok: true } {
  if (parsed.blocks.length === 0) return { ok: true };
  const target = params.in ?? fragmentScope(params);
  if (typeof target !== "string" || !target.startsWith("#")) return { ok: true };
  const scope = resolveScope(ctx, target, { allowSlugFallback: false });
  if (!scope.ok) return scopeError(scope);
  if (scope.scope.kind !== "section" || scope.scope.headingLevel === undefined) return { ok: true };
  const sectionLevel = scope.scope.headingLevel;
  const conflicting = parsed.blocks.find(
    (block) => block.attrs.level != null && Number(block.attrs.level) <= sectionLevel,
  );
  if (!conflicting) return { ok: true };
  return error(
    "invalid_write",
    "Section-scoped writes cannot insert a heading at the section level or above",
    { sectionLevel, insertedLevel: conflicting.attrs.level },
  );
}

function lowerInsertPosition(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): ResolveWriteFailure | { ok: true; after?: BlockRef } {
  const { blocks } = ctx;
  if (params.after) {
    const located = locateBlockByHash(ctx, params.after);
    if (!located.ok) return scopeError(located);
    return { ok: true, after: located.block };
  }
  if (params.before) {
    const located = locateBlockByHash(ctx, params.before);
    if (!located.ok) return scopeError(located);
    return located.index === 0 ? { ok: true } : { ok: true, after: blocks[located.index - 1] };
  }
  const last = blocks.at(-1);
  return last ? { ok: true, after: last } : { ok: true };
}

function deleteEdits(params: NormalizedParams, scope: BlockScope): ResolvedEdit[] {
  return scope.blocks.map((element) => ({
    documentId: params.documentAddress.documentId,
    file: params.documentAddress.filePath,
    kind: "delete",
    block: element,
  }));
}

interface FindMatchGroup {
  elements: BlockRef[];
  startIndex: number;
  endIndex: number;
  rangeStart: number;
  matches: TextFindMatch[];
}

function planFindMatches(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  matches: readonly TextFindMatch[],
  command: WriteCommandName,
): PlannedWrite | ResolveWriteFailure {
  const steps: PlannedStep[] = [];
  // Structural groups can replace their predecessor block. Lower from the end
  // so every insert anchor remains live until its group executes.
  for (const group of groupFindMatches(matches).reverse()) {
    const groupSource = ctx.codec
      .serializeBlockBodies(
        ctx.projected.slice(group.startIndex, group.endIndex + 1).map((block) => block.node),
      )
      .join("\n\n");
    const spliced = spliceFindMatches(
      groupSource,
      group.matches,
      group.rangeStart,
      params.content,
      command,
    );
    const scope: BlockScope = {
      kind: "range",
      blocks: group.elements,
      startIndex: group.startIndex,
      endIndex: group.endIndex,
    };
    const step = planSplicedGroup(ctx, scope, groupSource, spliced);
    if ("ok" in step) return step;
    steps.push(step);
  }
  return { steps };
}

function groupFindMatches(matches: readonly TextFindMatch[]): FindMatchGroup[] {
  const groups: FindMatchGroup[] = [];
  for (const match of matches) {
    const last = groups.at(-1);
    if (last && match.startIndex <= last.endIndex) {
      const known = new Set(last.elements);
      for (const element of match.elements) {
        if (!known.has(element)) last.elements.push(element);
      }
      last.startIndex = Math.min(last.startIndex, match.startIndex);
      last.endIndex = Math.max(last.endIndex, match.endIndex);
      last.rangeStart = Math.min(last.rangeStart, match.rangeStart);
      last.matches.push(match);
      continue;
    }
    groups.push({
      elements: [...match.elements],
      startIndex: match.startIndex,
      endIndex: match.endIndex,
      rangeStart: match.rangeStart,
      matches: [match],
    });
  }
  return groups;
}

/**
 * Parse a group's spliced text with source spans, so ref assignment can tell the
 * splice's occurrences from the untouched ones around it (§5.4).
 */
function planSplicedGroup(
  ctx: ConcreteResolveContext,
  scope: BlockScope,
  oldText: string,
  spliced: SplicedGroup,
): PlannedStep | ResolveWriteFailure {
  if (spliced.text.length === 0) return { kind: "replace", scope, blocks: [] };
  try {
    const oldGroup = scopeNodes(ctx, scope);
    const parsed = ctx.codec.parseWithSpans(spliced.text);
    const oldWindows = cutTextWindows(
      ctx,
      oldText,
      spliced.cuts.map((cut) => cut.old),
      oldGroup,
    );
    const newWindows = cutTextWindows(
      ctx,
      spliced.text,
      spliced.cuts.map((cut) => cut.new),
      parsed.blocks,
    );
    return {
      kind: "spliced",
      scope,
      oldGroup,
      oldText,
      oldSpans: ctx.codec.parseWithSpans(oldText).spans,
      newText: spliced.text,
      parsed,
      splice: spliced.splice,
      windows: oldWindows && newWindows ? { old: oldWindows, new: newWindows } : null,
    };
  } catch (cause) {
    if (cause instanceof CodecParseError) {
      return error("invalid_write", cause.message, { line: cause.line, column: cause.column });
    }
    return error("invalid_write", cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Rewrite a scope as assigned `newBlocks`: blocks equal to their replacement are
 * left alone, a changed block keeps its identity and is changed in place, and
 * only blocks with no counterpart are inserted or removed. Atoms (pictures,
 * hard breaks) are units of their textblock, matched as nodes, never as text. With
 * `windows`, a changed block is rewritten only inside them; otherwise it is
 * word-diffed whole.
 */
function replaceScope(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  scope: BlockScope,
  newBlocks: readonly Block[],
  windows: CutWindows | null = null,
): LoweredScope {
  const edits: ResolvedEdit[] = [];
  const oldBlocks = scope.blocks;
  const oldNodes = scopeNodes(ctx, scope);
  let anchor: BlockRef | undefined =
    scope.startIndex > 0 ? ctx.projected[scope.startIndex - 1]?.ref : undefined;
  let pendingInsert: Block[] = [];
  let pendingDelete: BlockRef[] = [];
  let keptBlocks = false;
  let structuralBoundary: object | undefined;
  let insertionRun = {};

  const flushStructural = () => {
    if (pendingInsert.length > 0) {
      edits.push({
        ...insertEdit(
          params,
          anchor,
          pendingInsert,
          serializeReplacementBlocks(ctx, pendingInsert),
        ),
        structuralBoundary,
        insertionRun,
      });
    }
    for (const block of pendingDelete) {
      edits.push({
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "delete",
        block,
        structuralBoundary,
      });
    }
    pendingInsert = [];
    pendingDelete = [];
    structuralBoundary = undefined;
  };

  for (const step of alignBlocks(oldNodes, newBlocks)) {
    switch (step.kind) {
      case "remove":
        if (structuralBoundary !== step.structuralBoundary) flushStructural();
        structuralBoundary = step.structuralBoundary;
        pendingDelete.push(oldBlocks[step.old]);
        break;
      case "add":
        if (structuralBoundary !== step.structuralBoundary) flushStructural();
        structuralBoundary = step.structuralBoundary;
        pendingInsert.push(newBlocks[step.next]);
        break;
      case "change": {
        flushStructural();
        const before = oldNodes[step.old];
        const after = newBlocks[step.next];
        const lowered = lowerBlock(
          ctx.codec,
          before,
          after,
          windows && [windows.old[step.old], windows.new[step.next]],
        );
        anchor = oldBlocks[step.old];
        insertionRun = {};
        if (lowered) {
          if (lowered.length === 0) keptBlocks = true;
          else
            edits.push({
              documentId: params.documentAddress.documentId,
              file: params.documentAddress.filePath,
              block: oldBlocks[step.old],
              structuralBoundary: step.structuralBoundary,
              kind: "ops",
              ops: lowered,
            });
          break;
        }
        edits.push({
          documentId: params.documentAddress.documentId,
          file: params.documentAddress.filePath,
          block: oldBlocks[step.old],
          structuralBoundary: step.structuralBoundary,
          kind: "block",
          replacement: after,
        });
        break;
      }
      case "keep":
        flushStructural();
        anchor = oldBlocks[step.old];
        insertionRun = {};
        keptBlocks = true;
        break;
    }
  }
  flushStructural();

  return { edits, ...(keptBlocks ? { keptBlocks: true } : {}) };
}

function serializeReplacementBlocks(
  ctx: Pick<ConcreteResolveContext, "codec">,
  blocks: Block[],
): string {
  return trimOneTrailingNewline(ctx.codec.serialize(blocks));
}

function fragmentScope(params: NormalizedParams): string | undefined {
  return params.documentAddress.fragment ? `#${params.documentAddress.fragment}` : undefined;
}

function trimOneTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function semanticIrForResolvedEdits(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  resolved: Extract<ResolveWriteResultWithoutIr, { ok: true }>,
): SemanticEditIRV1 {
  const { edits } = resolved;
  const scope: LineageRange[] = [];
  const deleted: LineageRange[] = [];
  const mappedEdits = edits.map((edit) => {
    let outputRuns: SemanticOutputRun[] = [];
    if (edit.kind === "ops") {
      const lineage = ctx.model.getVisibleContentLineage(edit.block);
      scope.push(...lineage);
      let output = 0;
      for (const op of edit.ops) {
        if (op.kind !== "text") continue;
        for (const splice of op.splices) {
          deleted.push(...ctx.model.textblockLineage(edit.block, op.path, splice.from, splice.to));
          const text = splice.content.textBetween(0, splice.content.size, "");
          if (text.length > 0)
            outputRuns.push({
              kind: "fresh",
              payload: text,
              output: { from: output, to: output + text.length },
            });
          output += text.length;
        }
      }
    } else if (edit.kind === "insert") {
      if (edit.newText.length > 0) {
        outputRuns = [
          {
            kind: "fresh",
            payload: edit.newText,
            output: { from: 0, to: edit.newText.length },
          },
        ];
      }
    } else {
      const lineage = ctx.model.getVisibleContentLineage(edit.block);
      scope.push(...lineage);
      deleted.push(...lineage);
      if (edit.kind === "block" && edit.replacement.textContent.length > 0) {
        outputRuns = [
          {
            kind: "fresh",
            payload: edit.replacement.textContent,
            output: { from: 0, to: edit.replacement.textContent.length },
          },
        ];
      }
    }
    return { edit, outputRuns };
  });
  const normalizedScope = normalizeLineageRanges(scope);
  const normalizedDeleted = normalizeLineageRanges(deleted);
  // Its payload is the whole requested content, so it only describes a scope
  // whose every block was rewritten.
  const isTotalFreshReplacement =
    params.command === "replace" &&
    params.find === undefined &&
    resolved.keptBlocks === undefined &&
    normalizedScope.length > 0 &&
    sameLineageRanges(normalizedScope, normalizedDeleted);
  return {
    version: 1,
    documentId: params.documentAddress.documentId,
    inputRevision: (ctx.inputRevision ??
      documentRevision(ctx)) as SemanticEditIRV1["inputRevision"],
    scope: normalizedScope,
    intent: isTotalFreshReplacement
      ? { kind: "fullScopeFreshReplacement", payload: params.content }
      : { kind: "mappedEdits", edits: mappedEdits },
    deleted: normalizedDeleted,
  };
}

function sameLineageRanges(left: readonly LineageRange[], right: readonly LineageRange[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.clientID === right[index]?.clientID &&
        range.clock === right[index]?.clock &&
        range.length === right[index]?.length,
    )
  );
}

/** The revision a semantic IR names: the document's state vector, in hex. */
export function documentRevision(ctx: { model: AgentEditModel; doc: DocHandle }): string {
  return [...ctx.model.encodeStateVector(ctx.doc)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function scopeError(result: ScopeFailure): ResolveWriteFailure {
  if (result.code === "ambiguous") return error("ambiguous_match", result.message);
  return error(
    result.code,
    result.message,
    result.documentBlocks === undefined ? undefined : { documentBlocks: result.documentBlocks },
  );
}

function findError(
  result: Extract<ReturnType<typeof findTextMatches>, { ok: false }>,
): ResolveWriteFailure {
  return error(
    result.code,
    result.message,
    result.count === undefined ? undefined : { count: result.count },
  );
}

function error(
  code: EditResolutionErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ResolveWriteFailure {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
