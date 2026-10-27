/**
 * The `ls` tool (file-access §6): rows the file policy lets the
 * agent see, each marked read-only when it can't edit it. A `live` listing
 * reads no draft, so its rows are decided live. `ls` returns a typed listing
 * the model reads as plain text (D61).
 */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { ContextFileEntry } from "../../domains/context/index.js";
import {
  isSkillsUri,
  type LsEntry,
  type LsResult,
  type LsToolInput,
  listSkillDir,
  skillsRootEntries,
  sortLsEntries,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { containerReadonly, withBranchWork } from "./file-access.js";
import {
  contextToolError,
  isToolError,
  resolveToolCall,
  type ToolCall,
  type ToolErrorOutput,
  type ToolWiringDeps,
  toolError,
} from "./tool-context.js";

export async function listingCall(
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
  version: LsToolInput["version"],
): Promise<ToolCall | ToolErrorOutput> {
  const call = await resolveToolCall(deps, ctx, version);
  if (isToolError(call) || version !== "live") return call;
  return { ...call, principal: withBranchWork(call.principal, null) };
}

/** `ls scratch://@` and `ls uploads://@` list owners, each a distinct container of its own. */
function isOwnerListing(path: string): boolean {
  const parsed = parseUnifiedContextUri(path);
  return parsed.ok && parsed.value.authority.kind === "owners";
}

function listedDocumentIds(rows: readonly { documentId?: string }[]): DocumentId[] {
  return rows.flatMap((row) => (row.documentId ? [row.documentId as DocumentId] : []));
}

export function createLsHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext): Promise<LsResult | ToolErrorOutput> => {
    const { path, verbose = false, version } = input as LsToolInput;
    if (path && isSkillsUri(path)) {
      const skills = await listSkillDir(deps, ctx.threadId, path);
      return { uri: skills.uri, entries: sortLsEntries(skills.entries) };
    }
    const call = await listingCall(deps, ctx, version);
    if (isToolError(call)) return call;
    const { context, principal } = call;
    const result = await context.port.list(path, { wordCounts: verbose });
    if (!result.ok) {
      if (result.error.code === "not_found") {
        return toolError({
          code: "not_found",
          message: `No folder at ${result.error.uri}. Writing a file under this path creates the folder.`,
          details: result.error,
        });
      }
      return contextToolError(result.error);
    }
    const listed = result.value.entries;
    const access = await deps.fileAccess.listAccess(principal, listedDocumentIds(listed));
    // Ordinary folders share their container; source and lineage discovery list distinct owners.
    const folderReadonly =
      path && !isOwnerListing(path)
        ? await containerReadonly(deps, principal, context, path)
        : undefined;
    const entries = await Promise.all(
      listed.map(async (entry): Promise<LsEntry[]> => {
        if (entry.kind === "directory") {
          const readonly =
            folderReadonly ?? (await containerReadonly(deps, principal, context, entry.uri));
          return [
            {
              uri: entry.uri,
              title: entry.title,
              kind: "directory",
              readonly: readonly ?? entry.readonly ?? false,
            },
          ];
        }
        const decision = entry.documentId ? access.get(entry.documentId as DocumentId) : undefined;
        if (!decision) return [];
        return [{ ...lsFile(entry, verbose), readonly: decision.level !== "edit" }];
      }),
    );
    const listing = entries.flat();
    // Storage returns rows unordered; the model reads a sorted listing.
    if (path) return { uri: result.value.uri, entries: sortLsEntries(listing) };
    return { uri: null, entries: [...listing, ...(await skillsRootEntries(deps, ctx.threadId))] };
  };
}

/** A file row's model-facing fields; IDs and schema details stay behind (D61). */
function lsFile(entry: ContextFileEntry, verbose: boolean): Omit<LsEntry, "readonly"> {
  const text = entry.editable;
  return {
    uri: entry.uri,
    kind: "file",
    ...(text ? {} : { fileType: entry.fileType }),
    ...(verbose && text && entry.wordCount !== undefined ? { wordCount: entry.wordCount } : {}),
    ...(verbose && !text && entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    ...(verbose && entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}
