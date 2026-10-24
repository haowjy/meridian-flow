/**
 * The document an `undo`, `redo` or `revert` names by path (D76). A path no visible document
 * holds names the document this chat's latest move or delete took away from it after the visible
 * document has no matching stack entry; a deleted one
 * is authorized where its restore would bring it back (its own folder and source, which may
 * have moved since the path was shown), as the card's Undo is. A path a different document
 * now holds gets the first chance to reverse its own entry.
 */
import type { DocumentCommandName } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts";
import { type FileGrant, isFileAccessDenied } from "../../domains/file-policy/index.js";
import { removedFileResult } from "../file-access-denial-copy.js";
import { resolveDocumentAddress } from "./document-tools.js";
import { fileAccessDeniedError } from "./file-access.js";
import {
  canonicalPath,
  isToolError,
  type ResolvedDocumentAddress,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
} from "./tool-context.js";

type InverseCommand = "undo" | "redo" | "revert";

/** A missing path whose latest holder this chat removed, when its retained record is readable. */
export async function removedPathError(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: DocumentCommandName,
  path: string,
  threadId: string,
): Promise<WriteToolErrorOutput | null> {
  const canonical = await canonicalPath(call, path);
  const away = await deps.documentSync.treeHistory().movedAwayFrom(threadId as ThreadId, canonical);
  if (!away || (await deps.fileAccess.historyAccess(call.principal, away)) !== "deleted")
    return null;
  const removal = (await deps.documentRemovals.lookup([away])).get(away);
  return removal ? removedFileResult(command, removal, canonical) : null;
}

export type InverseTarget = {
  address: ResolvedDocumentAddress;
  /** Edit where a deleted document returns to, instead of the document's own grant. */
  grant?: FileGrant<"edit">;
};

export async function resolveInverseTarget(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: InverseCommand,
  path: string,
  threadId: string,
): Promise<InverseTarget | WriteToolErrorOutput> {
  const address = await resolveDocumentAddress(call.context, command, path);
  const visible = !isToolError(address);
  if (!visible && address.output.status !== "document_not_found") return address;
  if (visible) return { address };
  const canonical = await canonicalPath(call, path);
  const away = await deps.documentSync.treeHistory().movedAwayFrom(threadId as ThreadId, canonical);
  if (!away) return address;
  const removed = (await deps.documentRemovals.lookup([away])).has(away);
  if (!removed) {
    const uri = (await currentUri(call, away)) ?? canonical;
    return { address: { documentId: away, uri, filePath: uri } };
  }
  const grant = await deps.fileAccess.authorize(
    call.principal,
    { kind: "restore", documentId: away },
    "edit",
  );
  if (isFileAccessDenied(grant)) return fileAccessDeniedError(command, grant, canonical);
  return { address: { documentId: away, uri: canonical, filePath: canonical }, grant };
}

/** Where a document is now in the call's view, or null when it is nowhere. */
export async function currentUri(call: ToolCall, documentId: DocumentId): Promise<string | null> {
  const located = await call.context.port.locate(documentId);
  return located.ok ? (located.value?.uri ?? null) : null;
}

/**
 * When the visible document at `path` had nothing to reverse: the document this chat moved or
 * deleted away from that path, as a refusal that says where it went, or null.
 */
export async function resolveDisplacedTarget(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: InverseCommand,
  address: ResolvedDocumentAddress,
  threadId: string,
): Promise<InverseTarget | WriteToolErrorOutput | null> {
  const path = address.uri;
  const away = await deps.documentSync
    .treeHistory()
    .movedAwayFrom(threadId as ThreadId, await canonicalPath(call, path));
  if (!away || away === address.documentId) return null;
  const uri = await currentUri(call, away);
  if (uri) return { address: { documentId: away, uri, filePath: uri } };
  const grant = await deps.fileAccess.authorize(
    call.principal,
    { kind: "restore", documentId: away },
    "edit",
  );
  if (isFileAccessDenied(grant)) return fileAccessDeniedError(command, grant, path);
  return { address: { documentId: away, uri: path, filePath: path }, grant };
}
