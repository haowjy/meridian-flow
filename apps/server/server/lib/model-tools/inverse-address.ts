/**
 * The document an `undo`, `redo` or `revert` names by path (D76). A path no visible document
 * holds names the document this chat's latest move or delete took away from it; a deleted one
 * is authorized at the folder it would return to, as a restore is. A path a different document
 * now holds still names that one, and the result says so when it has nothing to reverse.
 */
import { splitDocumentFile } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts";
import { type FileGrant, isFileAccessDenied } from "../../domains/file-policy/index.js";
import { threadContainerTarget } from "../file-targets.js";
import { resolveDocumentAddress } from "./document-tools.js";
import { fileAccessDeniedError } from "./file-access.js";
import {
  isToolError,
  type ResolvedDocumentAddress,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

type InverseCommand = "undo" | "redo" | "revert";

export type InverseTarget = {
  address: ResolvedDocumentAddress;
  /** Edit at the folder a deleted document returns to, instead of the document's own grant. */
  grant?: FileGrant<"edit">;
};

/** Another document this chat moved or deleted away from the path a visible one now holds. */
type Displaced = { documentId: DocumentId; uri: string | null };

/** The path as a canonical URI: its folder's own URI (with any owner), then its name. */
async function canonicalPath(call: ToolCall, path: string): Promise<string> {
  const { filePath } = splitDocumentFile(path);
  const uri = filePath.includes("://") ? filePath : `manuscript://${filePath}`;
  const slash = uri.lastIndexOf("/");
  const listing = await call.context.port.list(uri.slice(0, slash + 1));
  const folder = listing.ok ? listing.value.uri : null;
  return folder ? `${folder.replace(/\/?$/, "/")}${uri.slice(slash + 1)}` : uri;
}

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
  const target = await threadContainerTarget(deps.works, call.context.resolution, canonical);
  if (!target) return address;
  const grant = await deps.fileAccess.authorize(call.principal, target, "edit");
  if (isFileAccessDenied(grant)) return fileAccessDeniedError(command, grant, canonical);
  return { address: { documentId: away, uri: canonical, filePath: canonical }, grant };
}

async function currentUri(call: ToolCall, documentId: DocumentId): Promise<string | null> {
  const located = await call.context.port.locate(documentId);
  return located.ok ? (located.value?.uri ?? null) : null;
}

/**
 * When the visible document at `path` had nothing to reverse: the document this chat moved or
 * deleted away from that path, as a refusal that says where it went, or null.
 */
export async function displacedRefusal(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: InverseCommand,
  address: ResolvedDocumentAddress,
  threadId: string,
): Promise<WriteToolErrorOutput | null> {
  const path = address.uri;
  const away = await deps.documentSync
    .treeHistory()
    .movedAwayFrom(threadId as ThreadId, await canonicalPath(call, path));
  if (!away || away === address.documentId) return null;
  const displaced: Displaced = { documentId: away, uri: await currentUri(call, away) };
  return writeToolError(
    command,
    displaced.uri
      ? `A different document is at ${path} now. The one you moved away is at ${displaced.uri}; ${command} it there.`
      : `A different document is at ${path} now. Ask the user to undo the deletion from your reply's card.`,
    "invalid_write",
    { path },
  );
}
