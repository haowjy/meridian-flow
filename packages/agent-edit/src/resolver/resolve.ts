import {
  CodecParseError,
  type ParsedContent,
  type ParsedContentWithSpans,
  walkLinkOccurrences,
} from "@meridian/markup";
import { Fragment } from "prosemirror-model";
import {
  type EditResolutionErrorCode,
  inlineReplacementText,
  type ResolvedEdit,
  type ResolvedInlineReplacement,
} from "../apply/types.js";
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
  findTextMatches,
  type SplicedGroup,
  serializeBlockBody,
  serializePmBlockBody,
  spliceFindMatches,
  type TextFindMatch,
} from "./find.js";
import { locateBlockByHash } from "./hash-locator.js";
import { type BlockScope, resolveScope, resolveSearchScope, type ScopeFailure } from "./scope.js";

export type WriteCommandName = "insert" | "replace" | "remove";

export interface ResolveWriteParams {
  documentAddress: DocumentAddress;
  command: WriteCommandName;
  content?: string;
  /** Already-parsed content, with the original source retained in `content` for semantic IR. */
  parsedContent?: ParsedContent;
  /**
   * Blocks copied from another document (D23). They take the place of
   * `content` and are inserted as nodes, never through markup.
   */
  blocks?: readonly Block[];
  after?: string;
  before?: string;
  find?: string;
  in?: unknown;
  around?: string;
  all?: boolean;
}

export interface ResolveWriteContext {
  doc: DocHandle | null | undefined;
  model: AgentEditModel;
  codec: AgentEditCodec;
  /**
   * Ref assignment over the command's prepared link scope; parse itself is
   * pure syntax. Every door that turns written Markdown into nodes binds
   * through it before block alignment and no-op detection. Copies never do:
   * their nodes already carry what they name. Absent, nodes stay as parsed.
   */
  links?: WriteLinkAssigner;
  /** Exact revision whose live block handles and source ranges the resolver inspects. */
  inputRevision?: string;
}

export type ResolveWriteResult =
  | { ok: true; edits: ResolvedEdit[]; ir: SemanticEditIRV1 }
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
 * A write resolved up to binding: scope, find matches and splices are fixed,
 * and `written` holds every parsed node binding will see (a find's
 * reconstructed groups included), so the host can load what they name
 * before `bind` runs synchronously over the prepared scope.
 */
export type WritePlan =
  | {
      ok: true;
      written: readonly Block[];
      /** Ref assignment, then block alignment and no-op detection; absent links keep nodes as parsed. */
      bind(links: WriteLinkAssigner | undefined): ResolveWriteResult;
    }
  | ResolveWriteFailure;

export function planWrite(
  ctx: Omit<ResolveWriteContext, "links">,
  params: ResolveWriteParams,
): WritePlan {
  if (!ctx.doc)
    return error("document_not_found", `File not found: ${params.documentAddress.filePath}`);
  const doc = ctx.doc;
  let projected: Block[] | undefined;
  const concreteCtx: ConcreteResolveContext = {
    ...ctx,
    doc,
    // The document can't change while a write resolves, so one projection
    // serves every scope it replaces.
    projectedBlocks: () => {
      projected ??= ctx.model.projectBlocks(doc);
      return projected;
    },
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
        : step.kind === "edits" || !step.bind
          ? []
          : step.blocks,
    ),
    bind(links) {
      const resolved = bindPlannedWrite(concreteCtx, normalized, steps, links);
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        edits: resolved.edits,
        ir: semanticIrForResolvedEdits(concreteCtx, normalized, resolved),
      };
    },
  };
}

/** Plan and bind in one go, for callers whose written content was prepared up front. */
export function resolveWrite(
  ctx: ResolveWriteContext,
  params: ResolveWriteParams,
): ResolveWriteResult {
  const plan = planWrite(ctx, params);
  return plan.ok ? plan.bind(ctx.links) : plan;
}

/** One planned piece of a write, in edit order. */
type PlannedStep =
  /** Edits that need no binding: removes, copies, the plain-text find shortcut. */
  | { kind: "edits"; edits: ResolvedEdit[] }
  | { kind: "insert"; after: BlockRef | undefined; blocks: Block[]; bind: boolean }
  /** Rewrite `scope` as `blocks`, bound against the scope's old nodes. */
  | { kind: "replace"; scope: BlockScope; blocks: Block[]; bind: true }
  /** A formatted find's reconstructed group: only the splice's occurrences are assigned. */
  | {
      kind: "spliced";
      scope: BlockScope;
      oldGroup: Block[];
      oldText: string;
      oldSpans: ParsedContentWithSpans["spans"];
      newText: string;
      parsed: ParsedContentWithSpans;
      splice: SplicedGroup["splice"];
    };

interface PlannedWrite {
  steps: PlannedStep[];
}

function bindPlannedWrite(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  steps: readonly PlannedStep[],
  links: WriteLinkAssigner | undefined,
): ResolveWriteResultWithoutIr {
  const edits: ResolvedEdit[] = [];
  let keptBlocks = false;
  for (const step of steps) {
    switch (step.kind) {
      case "edits":
        edits.push(...step.edits);
        break;
      case "insert": {
        const blocks = step.bind ? bindSpan(links, [], step.blocks) : step.blocks;
        edits.push(insertEdit(params, step.after, blocks));
        break;
      }
      case "replace":
      case "spliced": {
        const lowered = replaceScope(ctx, params, step.scope, bindScope(ctx, step, links));
        edits.push(...lowered.edits);
        keptBlocks ||= lowered.keptBlocks === true;
        break;
      }
    }
  }
  return { ok: true, edits, ...(keptBlocks ? { keptBlocks: true } : {}) };
}

/** Bound before alignment, so an unchanged block stays `.eq` and is kept. */
function bindScope(
  ctx: ConcreteResolveContext,
  step: Extract<PlannedStep, { kind: "replace" | "spliced" }>,
  links: WriteLinkAssigner | undefined,
): Block[] {
  if (step.kind === "replace") return bindSpan(links, scopeNodes(ctx, step.scope), step.blocks);
  if (!links) return step.parsed.blocks;
  return links.bindSplice({
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
  return ctx.projectedBlocks().slice(scope.startIndex, scope.startIndex + scope.blocks.length);
}

type ResolveWriteResultWithoutIr =
  | {
      ok: true;
      edits: ResolvedEdit[];
      /** Some of the scope's blocks were already equal to their replacement and kept. */
      keptBlocks?: true;
    }
  | ResolveWriteFailure;

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
    return planFindMatches(ctx, params, parsed, found.matches, "insert");
  }

  const lowered = lowerInsertPosition(ctx, params);
  if (!lowered.ok) return lowered;
  return {
    steps: [{ kind: "insert", after: lowered.after, blocks: parsed.blocks, bind: !params.blocks }],
  };
}

const COPY_WITH_FIND_MESSAGE = "from copies whole blocks, so it can't be combined with find";

function insertEdit(
  params: NormalizedParams,
  after: BlockRef | undefined,
  blocks: readonly Block[],
  newText = params.content,
): ResolvedEdit {
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
  const anchor =
    scope.startIndex > 0 ? ctx.model.getBlocks(ctx.doc)[scope.startIndex - 1] : undefined;
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
    return planFindMatches(ctx, params, parsed, found.matches, "replace");
  }

  const target = params.in ?? fragmentScope(params);
  if (target === undefined) {
    return error("invalid_write", "replace needs `in`, `find` or a #heading-slug in path");
  }
  const scope = resolveScope(ctx, target, { allowSlugFallback: false });
  if (!scope.ok) return scopeError(scope);
  if (params.blocks) {
    if (params.blocks.length === 0) return error("invalid_write", "from selected no blocks");
    return replaceScopeWithCopies(ctx, params, scope.scope, params.blocks);
  }
  if (params.content.length === 0) {
    return error("invalid_write", "Use `remove` to remove blocks");
  }
  return { steps: [{ kind: "replace", scope: scope.scope, blocks: parsed.blocks, bind: true }] };
}

function planRemove(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): PlannedWrite | ResolveWriteFailure {
  const scope = resolveScope(ctx, params.in ?? fragmentScope(params), {
    allowSlugFallback: false,
  });
  if (!scope.ok) return scopeError(scope);
  return { steps: [{ kind: "edits", edits: deleteEdits(params, scope.scope) }] };
}

interface ConcreteResolveContext extends ResolveWriteContext {
  doc: DocHandle;
  /** Every top-level block as a ProseMirror node, in document order. */
  projectedBlocks(): readonly Block[];
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

function bindSpan(
  links: WriteLinkAssigner | undefined,
  old: readonly Block[],
  written: readonly Block[],
): Block[] {
  return links ? links.bindSpan(old, written) : [...written];
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
    (block) => block.type.name === "heading" && Number(block.attrs.level ?? 1) <= sectionLevel,
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
  const blocks = ctx.model.getBlocks(ctx.doc);
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
  parsed: ParsedContent,
  matches: readonly TextFindMatch[],
  command: WriteCommandName,
): PlannedWrite | ResolveWriteFailure {
  const plainTextEdits = lowerPlainTextFindMatches(ctx, params, parsed, matches, command);
  if (plainTextEdits) return { steps: [{ kind: "edits", edits: plainTextEdits }] };

  const steps: PlannedStep[] = [];
  // Structural groups can replace their predecessor block. Lower from the end
  // so every insert anchor remains live until its group executes.
  for (const group of groupFindMatches(matches).reverse()) {
    const groupSource = group.elements
      .map((element) => serializeBlockBody(ctx, element))
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

function lowerPlainTextFindMatches(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
  matches: readonly TextFindMatch[],
  command: WriteCommandName,
): ResolvedEdit[] | null {
  const content = plainTextInline(ctx, params.content, parsed);
  if (!content) return null;
  const byBlock = new Map<BlockRef, TextFindMatch[]>();
  for (const match of matches) {
    if (match.elements.length !== 1) return null;
    const [element] = match.elements;
    if (match.rangeSource !== ctx.model.getText(element)) return null;
    // A block holding a link goes through binding, so a ref- or title-only
    // change is never filtered out as equal text.
    const node = ctx.projectedBlocks()[match.startIndex];
    if (!node || walkLinkOccurrences([node]).length > 0) return null;
    const existing = byBlock.get(element);
    if (existing) existing.push(match);
    else byBlock.set(element, [match]);
  }
  const edits: ResolvedEdit[] = [];
  for (const [element, blockMatches] of byBlock) {
    const blockText = ctx.model.getText(element);
    const replacements = blockMatches
      .map((match) => ({
        span: {
          start: command === "insert" ? match.matchEnd : match.matchStart,
          end: match.matchEnd,
        },
        content,
      }))
      // Replacing a match with itself changes nothing, so it makes no edit.
      .filter(({ span }) => blockText.slice(span.start, span.end) !== params.content);
    if (replacements.length === 0) continue;
    edits.push({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "textRanges",
      block: element,
      replacements,
      output: replacementWindowOutput(blockText, replacements),
    });
  }
  return edits;
}

function replacementWindowOutput(
  source: string,
  replacements: readonly ResolvedInlineReplacement[],
): string {
  const first = replacements[0];
  if (!first) return "";
  let sourceCursor = first.span.start;
  let output = "";
  for (const replacement of replacements) {
    output += source.slice(sourceCursor, replacement.span.start);
    output += inlineReplacementText(replacement);
    sourceCursor = replacement.span.end;
  }
  return output;
}

/**
 * The parsed write's inline content when it is one plain-text paragraph whose
 * markup is its text; null when the write needs structural lowering.
 */
function plainTextInline(
  ctx: ConcreteResolveContext,
  content: string,
  parsed: ParsedContent,
): Fragment | null {
  if (content.length === 0) return Fragment.empty;
  if (parsed.blocks.length !== 1) return null;
  const [block] = parsed.blocks;
  const plain =
    block.isTextblock &&
    block.textContent === content &&
    serializePmBlockBody(ctx, block) === content;
  return plain ? block.content : null;
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
 * Parse a group's spliced text with source spans, so binding can tell the
 * splice's occurrences from the untouched ones around it (§5.4).
 */
function planSplicedGroup(
  ctx: ConcreteResolveContext,
  scope: BlockScope,
  oldText: string,
  spliced: SplicedGroup,
): PlannedStep | ResolveWriteFailure {
  if (spliced.text.length === 0) return { kind: "replace", scope, blocks: [], bind: true };
  try {
    return {
      kind: "spliced",
      scope,
      oldGroup: scopeNodes(ctx, scope),
      oldText,
      oldSpans: ctx.codec.parseWithSpans(oldText).spans,
      newText: spliced.text,
      parsed: ctx.codec.parseWithSpans(spliced.text),
      splice: spliced.splice,
    };
  } catch (cause) {
    if (cause instanceof CodecParseError) {
      return error("invalid_write", cause.message, { line: cause.line, column: cause.column });
    }
    return error("invalid_write", cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Rewrite a scope as bound `newBlocks`: blocks equal to their replacement are
 * left alone, a changed block keeps its identity and is diffed in place, and
 * only blocks with no counterpart are inserted or removed. Atoms (pictures,
 * hard breaks) are matched as nodes, never through flat text offsets.
 */
function replaceScope(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  scope: BlockScope,
  newBlocks: readonly Block[],
): { edits: ResolvedEdit[]; keptBlocks?: true } {
  const edits: ResolvedEdit[] = [];
  const oldBlocks = scope.blocks;
  const oldNodes = scopeNodes(ctx, scope);
  let anchor: BlockRef | undefined =
    scope.startIndex > 0 ? ctx.model.getBlocks(ctx.doc)[scope.startIndex - 1] : undefined;
  let pendingInsert: Block[] = [];
  let pendingDelete: BlockRef[] = [];
  let keptBlocks = false;

  const flushStructural = () => {
    if (pendingInsert.length > 0) {
      edits.push(
        insertEdit(params, anchor, pendingInsert, serializeReplacementBlocks(ctx, pendingInsert)),
      );
    }
    for (const block of pendingDelete) {
      edits.push({
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "delete",
        block,
      });
    }
    pendingInsert = [];
    pendingDelete = [];
  };

  for (const step of alignBlocks(oldNodes, newBlocks, canRewriteInPlace)) {
    switch (step.kind) {
      case "remove":
        pendingDelete.push(oldBlocks[step.old]);
        break;
      case "add":
        pendingInsert.push(newBlocks[step.next]);
        break;
      case "change":
        flushStructural();
        edits.push({
          documentId: params.documentAddress.documentId,
          file: params.documentAddress.filePath,
          kind: "block",
          block: oldBlocks[step.old],
          replacement: newBlocks[step.next],
        });
        anchor = oldBlocks[step.old];
        break;
      case "keep":
        flushStructural();
        anchor = oldBlocks[step.old];
        keptBlocks = true;
        break;
    }
  }
  flushStructural();

  return { edits, ...(keptBlocks ? { keptBlocks: true } : {}) };
}

/** A block keeps its element only as the same node type and heading level. */
function canRewriteInPlace(old: Block, next: Block): boolean {
  if (old.type !== next.type) return false;
  return old.type.name !== "heading" || old.attrs.level === next.attrs.level;
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
    if (edit.kind === "textRanges") {
      const lineage = ctx.model.getVisibleContentLineage(edit.block);
      scope.push(...lineage);
      for (const replacement of edit.replacements) {
        deleted.push(...sliceLineage(lineage, replacement.span.start, replacement.span.end));
      }
      outputRuns = semanticRunsForTextRanges(lineage, edit);
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

function semanticRunsForTextRanges(
  lineage: readonly LineageRange[],
  edit: Extract<ResolvedEdit, { kind: "textRanges" }>,
): SemanticOutputRun[] {
  const first = edit.replacements[0];
  if (!first) return [];
  const runs: SemanticOutputRun[] = [];
  let sourceCursor = first.span.start;
  let outputCursor = 0;
  for (const replacement of edit.replacements) {
    for (const source of sliceLineage(lineage, sourceCursor, replacement.span.start)) {
      runs.push({
        kind: "preserved",
        source,
        output: { from: outputCursor, to: outputCursor + source.length },
        materialization: "retained",
      });
      outputCursor += source.length;
    }
    const text = inlineReplacementText(replacement);
    if (text.length > 0) {
      runs.push({
        kind: "fresh",
        payload: text,
        output: { from: outputCursor, to: outputCursor + text.length },
      });
      outputCursor += text.length;
    }
    sourceCursor = replacement.span.end;
  }
  return runs;
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

function sliceLineage(lineage: readonly LineageRange[], from: number, to: number): LineageRange[] {
  const slices: LineageRange[] = [];
  let cursor = 0;
  for (const range of lineage) {
    const start = Math.max(from, cursor);
    const end = Math.min(to, cursor + range.length);
    if (start < end) {
      slices.push({
        clientID: range.clientID,
        clock: range.clock + start - cursor,
        length: end - start,
      });
    }
    cursor += range.length;
  }
  return slices;
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
