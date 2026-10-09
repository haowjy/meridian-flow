/**
 * The `ls` and `search` tools (file-access §6): rows the file policy lets the
 * agent see, each marked read-only when it can't edit it. A `live` listing
 * reads no draft, so its rows are decided live. `ls` returns a typed listing
 * the model reads as plain text (D61).
 */
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { ContextFileEntry, SearchResult } from "../../domains/context/index.js";
import {
  isSkillsUri,
  type LsEntry,
  type LsResult,
  type LsToolInput,
  listSkillDir,
  refuseSkillSearch,
  type SearchToolInput,
  type ShownLinkShowing,
  searchPassage,
  skillsRootEntries,
  sortLsEntries,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { containerReadonly, withDraftWork } from "./file-access.js";
import {
  contextToolError,
  isToolError,
  resolveToolCall,
  type ToolCall,
  type ToolErrorOutput,
  type ToolWiringDeps,
} from "./tool-context.js";

async function listingCall(
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
  version: LsToolInput["version"],
): Promise<ToolCall | ToolErrorOutput> {
  const call = await resolveToolCall(deps, ctx, version);
  if (isToolError(call) || version !== "live") return call;
  return { ...call, principal: withDraftWork(call.principal, null) };
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
    if (!result.ok) return contextToolError(result.error);
    const listed = result.value.entries;
    const access = await deps.fileAccess.listAccess(principal, listedDocumentIds(listed));
    // Folders below a path share its container; the root lists one per source.
    const folderReadonly = path
      ? await containerReadonly(deps, principal, context, path)
      : undefined;
    const entries = await Promise.all(
      listed.map(async (entry): Promise<LsEntry[]> => {
        if (entry.kind === "directory") {
          const readonly =
            folderReadonly ?? (await containerReadonly(deps, principal, context, entry.uri));
          return [
            { uri: entry.uri, kind: "directory", readonly: readonly ?? entry.readonly ?? false },
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

export function createSearchHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const { pattern, scope, verbose = false, version } = input as SearchToolInput;
    const skillRefusal = refuseSkillSearch(scope);
    if (skillRefusal) return skillRefusal;
    const call = await listingCall(deps, ctx, version);
    if (isToolError(call)) return call;
    const { context, principal } = call;
    const result = await context.port.search(pattern, scope);
    if (!result.ok) return contextToolError(result.error);
    const access = await deps.fileAccess.listAccess(principal, listedDocumentIds(result.value));
    const hits = result.value.flatMap((hit) => {
      const decision = hit.documentId ? access.get(hit.documentId as DocumentId) : undefined;
      return decision ? [{ hit, readonly: decision.level !== "edit" }] : [];
    });
    return {
      // Host-only facts never reach the model.
      output: hits.map(
        ({ hit: { documentId: _id, revision: _revision, shown: _shown, ...hit }, readonly }) => ({
          ...hit,
          readonly,
        }),
      ),
      // Only returned, authorized hits were shown, and only the passages their text shows whole.
      shown: hits.flatMap(({ hit }) => shownPassages(hit, pattern, verbose)),
      metadata: {
        documentRevisions: hits.map(
          ({ hit: { documentId, uri, revision } }) =>
            ({ documentId, uri, revision }) satisfies DocumentRevisionEvidence,
        ),
      },
    };
  };
}

/**
 * A hit's showing as the model receives it: a passage whose window cut its
 * block claims none of its links, since the window may have left one out or
 * split it. Whole passages keep theirs.
 */
function shownPassages(hit: SearchResult, pattern: string, verbose: boolean): ShownLinkShowing[] {
  const shown = hit.shown;
  if (!shown) return [];
  const links = hit.matches.flatMap(({ excerpt }, index) =>
    searchPassage(excerpt, pattern, verbose).whole ? (shown.passages[index] ?? []) : [],
  );
  if (links.length === 0) return [];
  return [{ documentId: hit.documentId, holderUri: shown.holderUri, view: shown.view, links }];
}
