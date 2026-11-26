import { CodecParseError, type ParsedContent } from "@meridian/markup";
import type { EditResolutionErrorCode, ResolvedEdit } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import type { DocumentAddress } from "../document-address.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { WriteLinkAssigner } from "../links/assign-refs.js";
import type { AgentEditModel } from "../ports/model.js";
import { alignBlocks } from "./block-alignment.js";
import {
  cutTextWindows,
  documentBodies,
  documentEntries,
  findTextMatches,
  joinEntries,
  type SplicedGroup,
  spliceFindMatches,
  type TextFindMatch,
} from "./find.js";
import { type HashLocateContext, hashLocateContext, locateBlockByHash } from "./hash-locator.js";
import { landCopies } from "./land-copies.js";
import { lowerBlock } from "./lower-block.js";
import type { CutWindows, PlainEdit, PlannedStep } from "./planned-step.js";
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
  parsedContent?: ParsedContent;
  blocks?: readonly Block[];
  after?: string;
  before?: string;
  find?: string;
  in?: unknown;
  around?: string;
  all?: boolean;
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
}

export type WriteLinks = WriteLinkAssigner | "preassigned";

export type ResolveWriteResult =
  | {
      ok: true;
      edits: ResolvedEdit[];
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

export type WritePlan =
  | {
      ok: true;
      written: readonly Block[];
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

  const planned = planCommand(concreteCtx, normalized);
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
      return assignPlannedWrite(concreteCtx, normalized, steps, links);
    },
  };
}

function planCommand(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): PlannedWrite | ResolveWriteFailure {
  switch (params.command) {
    case "insert":
      return planInsert(ctx, params);
    case "replace":
      return planReplace(ctx, params);
    case "remove":
      return planRemove(ctx, params);
  }
}

export function resolveWrite(
  ctx: ResolveWriteContext,
  params: ResolveWriteParams,
): ResolveWriteResult {
  const plan = planWrite(ctx, params);
  return plan.ok ? plan.assign(ctx.links) : plan;
}

interface PlannedWrite {
  steps: PlannedStep[];
}

function assignPlannedWrite(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  steps: readonly PlannedStep[],
  links: WriteLinks,
): ResolveWriteResult {
  const edits: ResolvedEdit[] = [];
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
        edits.push(
          ...replaceScope(
            ctx,
            params,
            step.scope,
            assignScope(ctx, step, links),
            step.kind === "spliced" ? step.windows : null,
          ),
        );
        break;
      }
    }
  }
  return { ok: true, edits };
}

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

function scopeNodes(ctx: ConcreteResolveContext, scope: BlockScope): Block[] {
  return ctx.projected
    .slice(scope.startIndex, scope.startIndex + scope.blocks.length)
    .map((block) => block.node);
}

function planInsert(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): PlannedWrite | ResolveWriteFailure {
  if (params.find !== undefined) {
    if (params.blocks) return error("invalid_write", COPY_WITH_FIND_MESSAGE);
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around, {
      allowSlugFallback: false,
    });
    if (!scope.ok) return scopeError(scope);
    const found = findTextMatches(ctx, scope.scope, params.find, params.all === true);
    if (!found.ok) return findError(found);
    const sectionCheck = checkFindSection(ctx, params, found.matches);
    if (!sectionCheck.ok) return sectionCheck;
    return planFindMatches(ctx, params, found.matches, "insert");
  }

  const lowered = lowerInsertPosition(ctx, params);
  if (!lowered.ok) return lowered;
  const parsed = params.blocks
    ? sectionChecked(ctx, params, { blocks: [...params.blocks] })
    : parseAt(ctx, params, lowered.beside);
  if (!parsed.ok) return parsed;
  const blocks = params.blocks
    ? landCopies(params.blocks, lowered.beside === null ? null : ctx.projected[lowered.beside].node)
    : parsed.parsed.blocks;
  return {
    steps: [{ kind: "insert", after: lowered.after, blocks, assign: !params.blocks }],
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

function replaceScopeWithCopies(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  scope: BlockScope,
  copies: readonly Block[],
): PlannedWrite {
  const anchor = scope.startIndex > 0 ? ctx.projected[scope.startIndex - 1]?.ref : undefined;
  const landed = landCopies(
    copies,
    params.wholeDocument ? null : ctx.projected[scope.startIndex].node,
  );
  return {
    steps: [
      { kind: "edits", edits: [insertEdit(params, anchor, landed), ...deleteEdits(params, scope)] },
    ],
  };
}

function planReplace(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): PlannedWrite | ResolveWriteFailure {
  if (params.find !== undefined) {
    if (params.blocks) return error("invalid_write", COPY_WITH_FIND_MESSAGE);
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around, {
      allowSlugFallback: false,
    });
    if (!scope.ok) return scopeError(scope);
    const found = findTextMatches(ctx, scope.scope, params.find, params.all === true);
    if (!found.ok) return findError(found);
    const sectionCheck = checkFindSection(ctx, params, found.matches);
    if (!sectionCheck.ok) return sectionCheck;
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
    const sectionCheck = sectionChecked(ctx, params, { blocks: [...params.blocks] });
    if (!sectionCheck.ok) return sectionCheck;
    return replaceScopeWithCopies(ctx, params, scope.scope, params.blocks);
  }
  if (params.content.length === 0 && !params.parsedContent) {
    return error("invalid_write", "replace content must not be empty; `remove` removes blocks");
  }
  const parsed = parseAt(ctx, params, params.wholeDocument ? null : scope.scope.startIndex);
  if (!parsed.ok) return parsed;
  return { steps: [{ kind: "replace", scope: scope.scope, blocks: parsed.parsed.blocks }] };
}

function planRemove(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): PlannedWrite | ResolveWriteFailure {
  const scope = writeScope(ctx, params, params.in ?? fragmentScope(params));
  if (!scope.ok) return scopeError(scope);
  return { steps: [{ kind: "edits", edits: deleteEdits(params, scope.scope) }] };
}

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
  const content = params.blocks
    ? serializeReplacementBlocks(ctx, [...params.blocks])
    : (params.content ?? "");
  return { ...params, content };
}

function assignSpan(links: WriteLinks, old: readonly Block[], written: readonly Block[]): Block[] {
  return links === "preassigned" ? [...written] : links.assignSpan(old, written);
}

function parseAt(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  beside: number | null,
): ResolveWriteFailure | { ok: true; parsed: ParsedContent } {
  if (params.parsedContent) return { ok: true, parsed: params.parsedContent };
  let parsed: ParsedContent;
  try {
    parsed = ctx.codec.parse(params.content, { within: openAt(ctx, beside) });
  } catch (cause) {
    if (cause instanceof CodecParseError) {
      return error("invalid_write", cause.message, { line: cause.line, column: cause.column });
    }
    return error("invalid_write", cause instanceof Error ? cause.message : String(cause));
  }
  return sectionChecked(ctx, params, parsed);
}

function sectionChecked(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): ResolveWriteFailure | { ok: true; parsed: ParsedContent } {
  const sectionCheck = validateSectionContent(ctx, params, parsed);
  return sectionCheck.ok ? { ok: true, parsed } : sectionCheck;
}

function openAt(ctx: ConcreteResolveContext, index: number | null): string | null {
  return index === null ? null : (documentEntries(ctx)[index]?.open ?? null);
}

function checkFindSection(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  matches: readonly TextFindMatch[],
): ResolveWriteFailure | { ok: true } {
  const parsed = parseAt(ctx, params, matches[0]?.startIndex ?? null);
  return parsed.ok ? { ok: true } : parsed;
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
): ResolveWriteFailure | { ok: true; after?: BlockRef; beside: number | null } {
  const { blocks } = ctx;
  if (params.after) {
    const located = locateBlockByHash(ctx, params.after);
    if (!located.ok) return scopeError(located);
    return { ok: true, after: located.block, beside: located.index };
  }
  if (params.before) {
    const located = locateBlockByHash(ctx, params.before);
    if (!located.ok) return scopeError(located);
    return located.index === 0
      ? { ok: true, beside: located.index }
      : { ok: true, after: blocks[located.index - 1], beside: located.index };
  }
  const last = blocks.at(-1);
  return last ? { ok: true, after: last, beside: blocks.length - 1 } : { ok: true, beside: null };
}

function deleteEdits(params: NormalizedParams, scope: BlockScope): PlainEdit[] {
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
    const groupSource = joinEntries(documentBodies(ctx, group.startIndex, group.endIndex));
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
    const step = planSplicedGroup(ctx, scope, groupSource, spliced, openAt(ctx, group.startIndex));
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

function planSplicedGroup(
  ctx: ConcreteResolveContext,
  scope: BlockScope,
  oldText: string,
  spliced: SplicedGroup,
  within: string | null,
): PlannedStep | ResolveWriteFailure {
  if (spliced.text.length === 0) return { kind: "replace", scope, blocks: [] };
  try {
    const oldGroup = scopeNodes(ctx, scope);
    const parsed = ctx.codec.parseWithSpans(spliced.text, { within });
    const oldWindows = cutTextWindows(
      ctx,
      oldText,
      spliced.cuts.map((cut) => cut.old),
      oldGroup,
      within,
    );
    const newWindows = cutTextWindows(
      ctx,
      spliced.text,
      spliced.cuts.map((cut) => cut.new),
      parsed.blocks,
      within,
    );
    return {
      kind: "spliced",
      scope,
      oldGroup,
      oldText,
      oldSpans: ctx.codec.parseWithSpans(oldText, { within }).spans,
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

const unclosed = (text: string) => text.replace(/\p{P}+$/u, "");

const endsWithRun = (text: string, run: string) =>
  text.endsWith(run) || unclosed(text).endsWith(run);

function edgeRun(first: string, second: string): string {
  for (let size = second.length; size > 0; size--) {
    const run = second.slice(0, size);
    if (/\s/.test(run[size - 1]) || (size < second.length && !/\s/.test(second[size]))) continue;
    if (!/[\p{L}\p{N}]/u.test(run)) continue;
    for (const end of [first, unclosed(first)]) {
      const at = end.length - size;
      if (at >= 0 && end.endsWith(run) && (at === 0 || /\s/.test(end[at - 1]))) return run;
    }
  }
  return "";
}

function replaceScope(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  scope: BlockScope,
  newBlocks: readonly Block[],
  windows: CutWindows | null = null,
): ResolvedEdit[] {
  const edits: ResolvedEdit[] = [];
  const oldBlocks = scope.blocks;
  const oldNodes = scopeNodes(ctx, scope);
  let anchor: BlockRef | undefined =
    scope.startIndex > 0 ? ctx.projected[scope.startIndex - 1]?.ref : undefined;
  let pendingInsert: Block[] = [];
  let pendingDelete: BlockRef[] = [];
  let structuralBoundary: object | undefined;
  let pieceOf: number | undefined;
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
        ...(pieceOf === undefined ? {} : { pieceOf: oldBlocks[pieceOf] }),
      });
    }
    for (const block of pendingDelete) {
      edits.push({
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "delete",
        block,
        structuralBoundary,
        ...(pieceOf === undefined ? {} : { pieceOf: oldBlocks[pieceOf] }),
      });
    }
    pendingInsert = [];
    pendingDelete = [];
    structuralBoundary = undefined;
    pieceOf = undefined;
  };

  const steps = alignBlocks(oldNodes, newBlocks);
  const stays = new Map<number, string>();
  for (const step of steps)
    if (step.kind === "keep" || step.kind === "change")
      stays.set(step.old, newBlocks[step.next].textContent);
  for (const step of steps) {
    switch (step.kind) {
      case "remove":
        if (structuralBoundary !== step.structuralBoundary || pieceOf !== step.pieceOf)
          flushStructural();
        structuralBoundary = step.structuralBoundary;
        pieceOf = step.pieceOf;
        pendingDelete.push(oldBlocks[step.old]);
        break;
      case "add":
        if (structuralBoundary !== step.structuralBoundary || pieceOf !== step.pieceOf)
          flushStructural();
        structuralBoundary = step.structuralBoundary;
        pieceOf = step.pieceOf;
        pendingInsert.push(newBlocks[step.next]);
        break;
      case "change": {
        flushStructural();
        const before = oldNodes[step.old];
        const after = newBlocks[step.next];
        const lowered = lowerBlock(before, after, {
          placed: windows && [windows.old[step.old], windows.new[step.next]],
          editors: (path) => ctx.model.unitEditors(oldBlocks[step.old], path),
          shownBy: {
            codec: ctx.codec,
            place: () => {
              const { body, open } = documentEntries(ctx)[scope.startIndex + step.old];
              return { body, open };
            },
          },
        });
        anchor = oldBlocks[step.old];
        insertionRun = {};
        const tookFrom = after.isTextblock
          ? [step.old - 1, step.old + 1].filter((at) => {
              const other = oldNodes[at];
              if (!other?.isTextblock) return false;
              const [was, now] = [before.textContent, after.textContent];
              const left = stays.get(at);
              if (at < step.old) {
                const run = edgeRun(other.textContent, now);
                return run !== "" && !was.startsWith(run) && !(left && endsWithRun(left, run));
              }
              const run = edgeRun(now, other.textContent);
              return run !== "" && !endsWithRun(was, run) && !left?.startsWith(run);
            })
          : [];
        if (lowered.length > 0)
          edits.push({
            documentId: params.documentAddress.documentId,
            file: params.documentAddress.filePath,
            block: oldBlocks[step.old],
            structuralBoundary: step.structuralBoundary,
            kind: "ops",
            ops: lowered,
            ...(tookFrom.length > 0 ? { tookFrom: tookFrom.map((at) => oldBlocks[at]) } : {}),
          });
        break;
      }
      case "keep":
        flushStructural();
        anchor = oldBlocks[step.old];
        insertionRun = {};
        break;
    }
  }
  flushStructural();

  return edits;
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
