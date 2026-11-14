/**
 * The `ls` tool (file-access §6): rows the file policy lets the
 * agent see, each marked read-only when it can't edit it. A `live` listing
 * reads no draft, so its rows are decided live. `ls` returns a typed listing
 * the model reads as plain text.
 */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import { childrenOf } from "@meridian/project-tree";
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
import { containerReadonly, withBranchOwner } from "./file-access.js";
import {
  areaOfPath,
  namesEvidence,
  type Reached,
  reachShown,
  wrongKindMessage,
} from "./shown-paths.js";
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
  return { ...call, principal: withBranchOwner(call.principal, null) };
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
    // The folder as the model meant it: a renamed or moved folder is found, and a path that is
    // a document says so.
    const reached = path
      ? await reachShown(call, ctx, "ls", path, { ...(version ? { version } : {}) })
      : null;
    if (reached && isToolError(reached))
      return toolError({ message: reached.output.message ?? "" });
    const wrongKind = reached?.node ? wrongKindMessage(reached.path, reached.node, "ls") : null;
    if (wrongKind) return toolError({ message: wrongKind });
    const result = await context.port.list(reached?.path ?? path, { wordCounts: verbose });
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
    if (path) {
      const names = await listedNames(call, path, reached, version, listing);
      return {
        uri: result.value.uri,
        entries: listing,
        ...(names ? { evidence: { shown: [], ...names } } : {}),
      };
    }
    return { uri: null, entries: [...listing, ...(await skillsRootEntries(deps, ctx.threadId))] };
  };
}

/**
 * What a listing showed of the tree: the folder as listed whole, and the node each listed name
 * means, so a name a listing did not have is known to be absent.
 */
async function listedNames(
  call: ToolCall,
  path: string,
  reached: Reached | null,
  version: LsToolInput["version"],
  listing: readonly LsEntry[],
) {
  const parts = areaOfPath(path);
  if (!parts) return null;
  const read = await call.context.port.readTree(parts.area, {
    ...(version ? { version } : {}),
    read: (scope) => {
      const projection = scope.writer.view(scope.view);
      const folder = reached?.node?.id ?? scope.root;
      const listed = new Set(
        listing.map((entry) =>
          entry.uri.replace(/\/$/, "").slice(entry.uri.replace(/\/$/, "").lastIndexOf("/") + 1),
        ),
      );
      return {
        whole: [folder],
        names: childrenOf(projection, folder)
          .filter((node) => listed.has(node.displayName))
          .map((node): [string, string, string] => [folder, node.displayName, node.id]),
      };
    },
  });
  return read.ok ? namesEvidence(read.value) : null;
}

/** A file row's model-facing fields; IDs and schema details stay behind. */
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
