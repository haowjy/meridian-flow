import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import { segmentOf } from "@meridian/project-tree";
import type { ContextFileEntry } from "../../domains/context/index.js";
import { listingDelta } from "../../domains/context/tree/names-shown.js";
import {
  isSkillsUri,
  type LsEntry,
  type LsResult,
  type LsToolInput,
  listSkillDir,
  type ResultEvidence,
  skillsRootEntries,
  sortLsEntries,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { containerReadonly, liveListing } from "./file-access.js";
import {
  areaOfPath,
  goneMessage,
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

function isOwnerListing(path: string): boolean {
  const parsed = parseUnifiedContextUri(path);
  return parsed.ok && parsed.value.authority.kind === "owners";
}

function listedDocumentIds(rows: readonly { documentId?: string }[]): DocumentId[] {
  return rows.flatMap((row) => (row.documentId ? [row.documentId as DocumentId] : []));
}

export function createLsHandler(deps: ToolWiringDeps) {
  return async (
    input: unknown,
    ctx: ToolHandlerContext,
  ): Promise<LsResult | (ToolErrorOutput & { evidence?: ResultEvidence })> => {
    const { path, verbose = false, version } = input as LsToolInput;
    if (path && isSkillsUri(path)) {
      const skills = await listSkillDir(deps, ctx.threadId, path);
      return { uri: skills.uri, entries: sortLsEntries(skills.entries) };
    }
    const call = await resolveToolCall(deps, ctx, version);
    if (isToolError(call)) return call;
    const { context, principal } = call;
    const reached = path
      ? await reachShown(deps, call, ctx, path, { ...(version ? { version } : {}) })
      : null;
    if (path && reached?.gone)
      return toolError({ code: "not_found", message: goneMessage(path, reached.gone) });
    const wrongKind = reached?.node ? wrongKindMessage(reached.path, reached.node, "ls") : null;
    if (wrongKind) return toolError({ message: wrongKind });
    const result = await context.port.list(reached?.path ?? path, { wordCounts: verbose });
    if (!result.ok) {
      if (result.error.code === "not_found") {
        return toolError({
          code: "not_found",
          message: `No folder at ${path?.trim().startsWith("~/") ? path.trim() : result.error.uri}. Writing a file under this path creates the folder.`,
          details: result.error,
        });
      }
      return contextToolError(result.error);
    }
    const listed = result.value.entries;
    const at = liveListing(version);
    const access = await deps.fileAccess.listAccess(principal, listedDocumentIds(listed), {
      ...(at ? { destination: at } : {}),
    });
    const folderReadonly =
      path && !isOwnerListing(path)
        ? await containerReadonly(deps, principal, context, path, at)
        : undefined;
    const entries = await Promise.all(
      listed.map(async (entry): Promise<LsEntry[]> => {
        if (entry.kind === "directory") {
          const readonly =
            folderReadonly ?? (await containerReadonly(deps, principal, context, entry.uri, at));
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
      const folder = reached?.node?.id ?? scope.root;
      const listed = new Set(
        listing.map((entry) =>
          entry.uri.replace(/\/$/, "").slice(entry.uri.replace(/\/$/, "").lastIndexOf("/") + 1),
        ),
      );
      return listingDelta(scope.writer.view(scope.view), folder, (node) =>
        listed.has(segmentOf(node)),
      );
    },
  });
  return read.ok ? namesEvidence(read.value) : null;
}

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
