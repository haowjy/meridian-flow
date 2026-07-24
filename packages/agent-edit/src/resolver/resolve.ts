import { CodecParseError, type ParsedContent } from "@meridian/markup";
import type { EditResolutionErrorCode, ResolvedEdit } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import type { DocumentAddress } from "../document-address.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { LineageRange } from "../lineage/range-set.js";
import { normalizeLineageRanges } from "../lineage/range-set.js";
import type { AgentEditModel } from "../ports/model.js";
import type { SemanticEditIRV1, SemanticOutputRun } from "../semantic-edit-ir.js";
import {
  findTextMatches,
  serializeBlockBody,
  serializePmBlockBody,
  type TextFindMatch,
} from "./find.js";
import { locateBlockByHash } from "./hash-locator.js";
import {
  type BlockScope,
  headingLevel,
  isHeading,
  resolveScope,
  resolveSearchScope,
  type ScopeFailure,
} from "./scope.js";

export type WriteCommandName = "insert" | "replace";

export interface ResolveWriteParams {
  documentAddress: DocumentAddress;
  command: WriteCommandName;
  content?: string;
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

export function resolveWrite(
  ctx: ResolveWriteContext,
  params: ResolveWriteParams,
): ResolveWriteResult {
  if (!ctx.doc)
    return error("document_not_found", `File not found: ${params.documentAddress.filePath}`);
  if (params.content === undefined) return error("invalid_write", "content is required");
  const normalized = normalizeParams(params);
  const concreteCtx: ConcreteResolveContext = { ...ctx, doc: ctx.doc };
  const contentCheck = validateContent(concreteCtx, normalized);
  if (!contentCheck.ok) return contentCheck;

  let resolved: ResolveWriteResultWithoutIr;
  switch (normalized.command) {
    case "insert":
      resolved = resolveInsert(concreteCtx, normalized, contentCheck.parsed);
      break;
    case "replace":
      resolved = resolveReplace(concreteCtx, normalized, contentCheck.parsed);
      break;
  }
  if (!resolved.ok) return resolved;
  return { ...resolved, ir: semanticIrForResolvedEdits(concreteCtx, normalized, resolved.edits) };
}

type ResolveWriteResultWithoutIr = { ok: true; edits: ResolvedEdit[] } | ResolveWriteFailure;

function resolveInsert(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): ResolveWriteResultWithoutIr {
  if (params.content.length === 0)
    return error("invalid_write", "insert requires non-empty content");
  if (params.after && params.before)
    return error("invalid_write", "`after` and `before` are mutually exclusive");
  if ((params.after || params.before) && params.find) {
    return error(
      "invalid_write",
      "Use either block targeting (`after`/`before`) or text targeting (`find`), not both",
    );
  }
  if (params.in !== undefined && !params.find) {
    return error(
      "invalid_write",
      "`in` scopes a find-based insert; use `after` or `before` for block positioning",
    );
  }

  const sectionCheck = validateSectionContent(ctx, params, parsed);
  if (!sectionCheck.ok) return sectionCheck;

  if (params.find !== undefined) {
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around, {
      allowSlugFallback: false,
    });
    if (!scope.ok) return scopeError(scope);
    const found = findTextMatches(ctx, scope.scope, params.find, params.all === true);
    if (!found.ok) return findError(found);
    return lowerFindMatches(ctx, params, found.matches, "insert");
  }

  const lowered = lowerInsertPosition(ctx, params);
  if (!lowered.ok) return lowered;
  return {
    ok: true,
    edits: [
      {
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "insert",
        ...(lowered.after ? { after: lowered.after } : {}),
        newText: params.content,
      },
    ],
  };
}

function resolveReplace(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): ResolveWriteResultWithoutIr {
  if (params.after || params.before) {
    return error(
      "invalid_write",
      "replace does not accept `after` or `before`; use `in` or `find`",
    );
  }
  const sectionCheck = validateSectionContent(ctx, params, parsed);
  if (!sectionCheck.ok) return sectionCheck;

  if (params.find !== undefined) {
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around, {
      allowSlugFallback: false,
    });
    if (!scope.ok) return scopeError(scope);
    const found = findTextMatches(ctx, scope.scope, params.find, params.all === true);
    if (!found.ok) return findError(found);
    return lowerFindMatches(ctx, params, found.matches, "replace");
  }

  if (params.around !== undefined) {
    return error("invalid_write", "`around` only scopes find-based replace commands");
  }
  const target = params.in ?? fragmentScope(params);
  if (target === undefined) return error("invalid_write", "replace without `find` requires `in`");
  const scope = resolveScope(ctx, target, { allowSlugFallback: false });
  if (!scope.ok) return scopeError(scope);
  if (params.content.length === 0) return deleteScope(params, scope.scope);
  return replaceScope(ctx, params, scope.scope, parsed);
}

interface ConcreteResolveContext extends ResolveWriteContext {
  doc: DocHandle;
}

function normalizeParams(params: ResolveWriteParams): NormalizedParams {
  return { ...params, content: params.content ?? "" };
}

function validateContent(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
): ResolveWriteFailure | { ok: true; parsed: ParsedContent } {
  if (params.find === "") return error("invalid_write", "`find` must not be empty");
  if (params.command === "insert" && params.content.length === 0) {
    return error("invalid_write", "insert requires non-empty content");
  }
  if (params.command === "replace" && params.content.length === 0) {
    return { ok: true, parsed: { blocks: [] } };
  }
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

function deleteScope(params: NormalizedParams, scope: BlockScope): ResolveWriteResultWithoutIr {
  return {
    ok: true,
    edits: scope.blocks.map((element) => ({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "delete",
      block: element,
    })),
  };
}

interface FindMatchGroup {
  elements: BlockRef[];
  startIndex: number;
  endIndex: number;
  rangeStart: number;
  matches: TextFindMatch[];
}

function lowerFindMatches(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  matches: readonly TextFindMatch[],
  command: WriteCommandName,
): ResolveWriteResultWithoutIr {
  const plainTextEdits = lowerPlainTextFindMatches(ctx, params, matches, command);
  if (plainTextEdits) return { ok: true, edits: plainTextEdits };

  const edits: ResolvedEdit[] = [];
  for (const group of groupFindMatches(matches)) {
    const groupSource = group.elements
      .map((element) => serializeBlockBody(ctx, element))
      .join("\n\n");
    const replacedSource = spliceFindMatches(
      groupSource,
      group.matches,
      group.rangeStart,
      params.content,
      command,
    );
    const parsed = parseReplacementRange(ctx, replacedSource);
    if (!parsed.ok) return parsed;
    const lowered = replaceScope(
      ctx,
      params,
      {
        kind: "range",
        blocks: group.elements,
        startIndex: group.startIndex,
        endIndex: group.endIndex,
      },
      parsed.parsed,
    );
    if (!lowered.ok) return lowered;
    edits.push(...lowered.edits);
  }
  return { ok: true, edits };
}

function lowerPlainTextFindMatches(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  matches: readonly TextFindMatch[],
  command: WriteCommandName,
): ResolvedEdit[] | null {
  if (!isPlainTextContent(ctx, params.content)) return null;
  const byBlock = new Map<BlockRef, TextFindMatch[]>();
  for (const match of matches) {
    if (match.elements.length !== 1) return null;
    const [element] = match.elements;
    if (match.rangeSource !== ctx.model.getText(element)) return null;
    const existing = byBlock.get(element);
    if (existing) existing.push(match);
    else byBlock.set(element, [match]);
  }
  const edits: ResolvedEdit[] = [];
  for (const [element, blockMatches] of byBlock) {
    const replacements = blockMatches.map((match) => ({
      span: {
        start: command === "insert" ? match.matchEnd : match.matchStart,
        end: match.matchEnd,
      },
      newText: params.content,
    }));
    const first = replacements[0];
    if (!first) continue;
    if (replacements.length === 1) {
      edits.push({
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "text",
        block: element,
        span: first.span,
        newText: first.newText,
        semanticLowering: "prosemirror",
      });
      continue;
    }
    const blockText = ctx.model.getText(element);
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
  replacements: readonly { span: { start: number; end: number }; newText: string }[],
): string {
  const first = replacements[0];
  if (!first) return "";
  let sourceCursor = first.span.start;
  let output = "";
  for (const replacement of replacements) {
    output += source.slice(sourceCursor, replacement.span.start);
    output += replacement.newText;
    sourceCursor = replacement.span.end;
  }
  return output;
}

function isPlainTextContent(ctx: ConcreteResolveContext, content: string): boolean {
  if (content.length === 0) return true;
  const parsed = parseReplacementRange(ctx, content);
  if (!parsed.ok || parsed.parsed.blocks.length !== 1) return false;
  const [block] = parsed.parsed.blocks;
  return (
    block.isTextblock &&
    block.textContent === content &&
    serializePmBlockBody(ctx, block) === content
  );
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

function spliceFindMatches(
  source: string,
  matches: readonly TextFindMatch[],
  rangeStart: number,
  content: string,
  command: WriteCommandName,
): string {
  let result = source;
  for (const match of [...matches].reverse()) {
    const start = match.rangeStart + match.matchStart - rangeStart;
    const end = match.rangeStart + match.matchEnd - rangeStart;
    const spliceStart = command === "insert" ? end : start;
    result = result.slice(0, spliceStart) + content + result.slice(end);
  }
  return result;
}

function parseReplacementRange(
  ctx: ConcreteResolveContext,
  source: string,
): ResolveWriteFailure | { ok: true; parsed: ParsedContent } {
  if (source.length === 0) return { ok: true, parsed: { blocks: [] } };
  try {
    return { ok: true, parsed: ctx.codec.parse(source) };
  } catch (cause) {
    if (cause instanceof CodecParseError) {
      return error("invalid_write", cause.message, { line: cause.line, column: cause.column });
    }
    return error("invalid_write", cause instanceof Error ? cause.message : String(cause));
  }
}

function replaceScope(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  scope: BlockScope,
  parsed: ParsedContent,
): ResolveWriteResultWithoutIr {
  const edits: ResolvedEdit[] = [];
  const oldBlocks = scope.blocks;
  const newBlocks = parsed.blocks;
  let anchor: BlockRef | undefined =
    scope.startIndex > 0 ? ctx.model.getBlocks(ctx.doc)[scope.startIndex - 1] : undefined;
  let pendingInsert: Block[] = [];
  let pendingDelete: BlockRef[] = [];

  const flushStructural = () => {
    if (pendingInsert.length > 0) {
      edits.push({
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "insert",
        ...(anchor ? { after: anchor } : {}),
        newText: serializeReplacementBlocks(ctx, pendingInsert),
      });
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

  const sharedCount = Math.min(oldBlocks.length, newBlocks.length);
  for (let index = 0; index < sharedCount; index += 1) {
    const oldBlock = oldBlocks[index];
    const newBlock = newBlocks[index];
    if (
      ctx.model.getBlockType(oldBlock) === newBlock.type.name &&
      reusableAttrs(ctx, oldBlock, newBlock)
    ) {
      flushStructural();
      edits.push(
        newBlock.isTextblock && newBlock.type.name !== "code_block"
          ? {
              documentId: params.documentAddress.documentId,
              file: params.documentAddress.filePath,
              kind: "text",
              block: oldBlock,
              span: { start: 0, end: ctx.model.getText(oldBlock).length },
              newText: serializePmBlockBody(ctx, newBlock),
              ...(params.find !== undefined ? { semanticLowering: "prosemirror" as const } : {}),
            }
          : {
              documentId: params.documentAddress.documentId,
              file: params.documentAddress.filePath,
              kind: "block",
              block: oldBlock,
              replacement: newBlock,
            },
      );
      anchor = oldBlock;
      continue;
    }
    pendingDelete.push(oldBlock);
    pendingInsert.push(newBlock);
  }

  for (let index = sharedCount; index < oldBlocks.length; index += 1) {
    pendingDelete.push(oldBlocks[index]);
  }

  for (let index = sharedCount; index < newBlocks.length; index += 1) {
    pendingInsert.push(newBlocks[index]);
  }
  flushStructural();

  return { ok: true, edits };
}

function reusableAttrs(ctx: ConcreteResolveContext, oldBlock: BlockRef, newBlock: Block): boolean {
  if (ctx.model.getBlockType(oldBlock) !== newBlock.type.name) return false;
  if (isHeading(ctx.model, oldBlock)) {
    return headingLevel(ctx.model, oldBlock) === Number(newBlock.attrs.level ?? 1);
  }
  return true;
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
  edits: readonly ResolvedEdit[],
): SemanticEditIRV1 {
  const scope: LineageRange[] = [];
  const deleted: LineageRange[] = [];
  const mappedEdits = edits.map((edit) => {
    let outputRuns: SemanticOutputRun[] = [];
    if (edit.kind === "text") {
      const lineage = ctx.model.getVisibleContentLineage(edit.block);
      scope.push(...lineage);
      deleted.push(...sliceLineage(lineage, edit.span.start, edit.span.end));
      if (edit.newText.length > 0) {
        outputRuns = [
          {
            kind: "fresh",
            payload: edit.newText,
            output: { from: 0, to: edit.newText.length },
          },
        ];
      }
    } else if (edit.kind === "textRanges") {
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
  const isTotalFreshReplacement =
    params.command === "replace" &&
    params.find === undefined &&
    normalizedScope.length > 0 &&
    sameLineageRanges(normalizedScope, normalizedDeleted);
  return {
    version: 1,
    documentId: params.documentAddress.documentId,
    inputRevision: (ctx.inputRevision ?? revisionOf(ctx)) as SemanticEditIRV1["inputRevision"],
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
      });
      outputCursor += source.length;
    }
    if (replacement.newText.length > 0) {
      runs.push({
        kind: "fresh",
        payload: replacement.newText,
        output: { from: outputCursor, to: outputCursor + replacement.newText.length },
      });
      outputCursor += replacement.newText.length;
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

function revisionOf(ctx: ConcreteResolveContext): string {
  return [...ctx.model.encodeStateVector(ctx.doc)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function scopeError(result: ScopeFailure): ResolveWriteResultWithoutIr {
  return error(result.code === "ambiguous" ? "ambiguous_match" : result.code, result.message);
}

function findError(
  result: Extract<ReturnType<typeof findTextMatches>, { ok: false }>,
): ResolveWriteResultWithoutIr {
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
