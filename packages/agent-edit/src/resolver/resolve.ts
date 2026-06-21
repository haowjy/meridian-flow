import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";
import type { EditResolutionErrorCode, ResolvedEdit } from "../apply/types.js";
import { type Codec, CodecParseError, type ParsedContent } from "../codec/types.js";
import type { YProsemirrorDocumentModel } from "../model/y-prosemirror.js";
import { lookupBlockHash } from "./block-hash.js";
import { findTextMatches, serializePmBlockBody } from "./find.js";
import {
  type BlockScope,
  headingLevel,
  isHeading,
  resolveScope,
  resolveSearchScope,
} from "./scope.js";

export type WriteCommandName = "insert" | "replace";

export interface ResolveWriteParams {
  documentId: string;
  file: string;
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
  model: YProsemirrorDocumentModel;
  codec: Codec;
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
  filePath: string;
  fileFragment?: string;
}

export function resolveWrite(
  ctx: ResolveWriteContext,
  params: ResolveWriteParams,
): ResolveWriteResult {
  if (!ctx.doc) return error("document_not_found", `File not found: ${params.file}`);
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
    return {
      ok: true,
      edits: found.matches.map((match) => ({
        documentId: params.documentId,
        file: params.filePath,
        kind: "text",
        element: match.element,
        span: { start: match.span.end, end: match.span.end },
        newText: params.content,
      })),
    };
  }

  const lowered = lowerInsertPosition(ctx, params);
  if (!lowered.ok) return lowered;
  return {
    ok: true,
    edits: [
      {
        documentId: params.documentId,
        file: params.filePath,
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
    return {
      ok: true,
      edits: found.matches.map((match) => ({
        documentId: params.documentId,
        file: params.filePath,
        kind: "text",
        element: match.element,
        span: match.span,
        newText: params.content,
      })),
    };
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
  const [filePath, fileFragment] = splitFileFragment(params.file);
  return { ...params, content: params.content ?? "", filePath, fileFragment };
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
      documentId: params.documentId,
      file: params.filePath,
      kind: "delete",
      element,
    })),
  };
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
      documentId: params.documentId,
      file: params.filePath,
      kind: "insert",
      ...(anchor ? { after: anchor } : {}),
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
        documentId: params.documentId,
        file: params.filePath,
        kind: "text",
        element: oldBlock,
        span: { start: 0, end: ctx.model.getText(oldBlock).length },
        newText: serializePmBlockBody(ctx, newBlock),
      });
      anchor = oldBlock;
      continue;
    }
    edits.push({
      documentId: params.documentId,
      file: params.filePath,
      kind: "delete",
      element: oldBlock,
    });
    pendingInsert.push(newBlock);
  }

  for (let index = sharedCount; index < oldBlocks.length; index += 1) {
    flushInsert();
    edits.push({
      documentId: params.documentId,
      file: params.filePath,
      kind: "delete",
      element: oldBlocks[index],
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
  return params.fileFragment ? `#${params.fileFragment}` : undefined;
}

function splitFileFragment(file: string): [string, string?] {
  const index = file.indexOf("#");
  if (index < 0) return [file];
  return [file.slice(0, index), file.slice(index + 1)];
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
