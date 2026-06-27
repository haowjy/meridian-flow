import { CodecParseError, type ParsedContent } from "@meridian/markup";
import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";
import type { EditResolutionErrorCode, ResolvedEdit } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocumentAddress } from "../document-address.js";
import { toRef } from "../model/block-ref.js";
import type { AgentEditModel } from "../ports/model.js";
import { lookupBlockHash } from "./block-hash.js";
import {
  findTextMatches,
  serializeBlockBody,
  serializePmBlockBody,
  type TextFindMatch,
} from "./find.js";
import {
  type BlockScope,
  headingLevel,
  isHeading,
  resolveScope,
  resolveSearchScope,
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
  doc: Y.Doc | null | undefined;
  model: AgentEditModel;
  codec: AgentEditCodec;
}

export type ResolveWriteResult =
  | { ok: true; edits: ResolvedEdit[] }
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

  switch (normalized.command) {
    case "insert":
      return resolveInsert(concreteCtx, normalized, contentCheck.parsed);
    case "replace":
      return resolveReplace(concreteCtx, normalized, contentCheck.parsed);
  }
}

function resolveInsert(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): ResolveWriteResult {
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
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around);
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
        ...(lowered.after ? { after: toRef(lowered.after) } : {}),
        newText: params.content,
      },
    ],
  };
}

function resolveReplace(
  ctx: ConcreteResolveContext,
  params: NormalizedParams,
  parsed: ParsedContent,
): ResolveWriteResult {
  if (params.after || params.before) {
    return error(
      "invalid_write",
      "replace does not accept `after` or `before`; use `in` or `find`",
    );
  }
  const sectionCheck = validateSectionContent(ctx, params, parsed);
  if (!sectionCheck.ok) return sectionCheck;

  if (params.find !== undefined) {
    const scope = resolveSearchScope(ctx, params.in ?? fragmentScope(params), params.around);
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
  const scope = resolveScope(ctx, target);
  if (!scope.ok) return scopeError(scope);
  if (params.content.length === 0) return deleteScope(params, scope.scope);
  return replaceScope(ctx, params, scope.scope, parsed);
}

interface ConcreteResolveContext extends ResolveWriteContext {
  doc: Y.Doc;
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
  const scope = resolveScope(ctx, target);
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
): ResolveWriteFailure | { ok: true; after?: Y.XmlElement } {
  const blocks = ctx.model.getBlocks(ctx.doc);
  if (params.after) {
    const lookup = lookupBlockHash(ctx.doc, params.after);
    if (!lookup.ok) return error("not_found", `Block hash "${params.after}" was not found`);
    return { ok: true, after: lookup.block };
  }
  if (params.before) {
    const lookup = lookupBlockHash(ctx.doc, params.before);
    if (!lookup.ok) return error("not_found", `Block hash "${params.before}" was not found`);
    const index = blocks.indexOf(lookup.block);
    if (index < 0) return error("not_found", `Block hash "${params.before}" was not found`);
    return index === 0 ? { ok: true } : { ok: true, after: blocks[index - 1] };
  }
  const last = blocks.at(-1);
  return last ? { ok: true, after: last } : { ok: true };
}

function deleteScope(params: NormalizedParams, scope: BlockScope): ResolveWriteResult {
  return {
    ok: true,
    edits: scope.blocks.map((element) => ({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "delete",
      block: toRef(element),
    })),
  };
}

interface FindMatchGroup {
  elements: Y.XmlElement[];
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
): ResolveWriteResult {
  const plainTextEdits = lowerPlainTextFindMatches(ctx, params, matches, command);
  if (plainTextEdits) return { ok: true, edits: plainTextEdits };

  const edits: ResolvedEdit[] = [];
  for (const group of groupFindMatches(matches)) {
    const groupSource = group.elements
      .map((element) => serializeBlockBody(ctx, element))
      .join("\n\n");
    const replacedSource = spliceFindMatches(groupSource, group, params.content, command);
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
  const edits: ResolvedEdit[] = [];
  for (const match of matches) {
    if (match.elements.length !== 1) return null;
    const [element] = match.elements;
    if (match.rangeSource !== ctx.model.getText(element)) return null;
    const start = command === "insert" ? match.matchEnd : match.matchStart;
    const end = match.matchEnd;
    edits.push({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "text",
      block: toRef(element),
      span: { start, end },
      newText: params.content,
    });
  }
  return edits;
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
  group: FindMatchGroup,
  content: string,
  command: WriteCommandName,
): string {
  let result = source;
  for (const match of [...group.matches].reverse()) {
    const start = match.rangeStart + match.matchStart - group.rangeStart;
    const end = match.rangeStart + match.matchEnd - group.rangeStart;
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
): ResolveWriteResult {
  const edits: ResolvedEdit[] = [];
  const oldBlocks = scope.blocks;
  const newBlocks = parsed.blocks;
  let anchor: Y.XmlElement | undefined =
    scope.startIndex > 0 ? ctx.model.getBlocks(ctx.doc)[scope.startIndex - 1] : undefined;
  let pendingInsert: PMNode[] = [];

  const flushInsert = () => {
    if (pendingInsert.length === 0) return;
    edits.push({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "insert",
      ...(anchor ? { after: toRef(anchor) } : {}),
      newText: serializeReplacementBlocks(ctx, pendingInsert),
    });
    pendingInsert = [];
  };

  const sharedCount = Math.min(oldBlocks.length, newBlocks.length);
  for (let index = 0; index < sharedCount; index += 1) {
    const oldBlock = oldBlocks[index];
    const newBlock = newBlocks[index];
    if (oldBlock.nodeName === newBlock.type.name && reusableAttrs(oldBlock, newBlock)) {
      flushInsert();
      edits.push({
        documentId: params.documentAddress.documentId,
        file: params.documentAddress.filePath,
        kind: "text",
        block: toRef(oldBlock),
        span: { start: 0, end: ctx.model.getText(oldBlock).length },
        newText: serializePmBlockBody(ctx, newBlock),
      });
      anchor = oldBlock;
      continue;
    }
    edits.push({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "delete",
      block: toRef(oldBlock),
    });
    pendingInsert.push(newBlock);
  }

  for (let index = sharedCount; index < oldBlocks.length; index += 1) {
    flushInsert();
    edits.push({
      documentId: params.documentAddress.documentId,
      file: params.documentAddress.filePath,
      kind: "delete",
      block: toRef(oldBlocks[index]),
    });
  }

  for (let index = sharedCount; index < newBlocks.length; index += 1) {
    pendingInsert.push(newBlocks[index]);
  }
  flushInsert();

  return { ok: true, edits };
}

function reusableAttrs(oldBlock: Y.XmlElement, newBlock: PMNode): boolean {
  if (oldBlock.nodeName !== newBlock.type.name) return false;
  if (isHeading(oldBlock)) return headingLevel(oldBlock) === Number(newBlock.attrs.level ?? 1);
  return true;
}

function serializeReplacementBlocks(
  ctx: Pick<ConcreteResolveContext, "codec">,
  blocks: PMNode[],
): string {
  return trimOneTrailingNewline(ctx.codec.serialize(blocks));
}

function fragmentScope(params: NormalizedParams): string | undefined {
  return params.documentAddress.fragment ? `#${params.documentAddress.fragment}` : undefined;
}

function trimOneTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function scopeError(
  result: Extract<ReturnType<typeof resolveScope>, { ok: false }>,
): ResolveWriteResult {
  return error(result.code, result.message);
}

function findError(
  result: Extract<ReturnType<typeof findTextMatches>, { ok: false }>,
): ResolveWriteResult {
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
