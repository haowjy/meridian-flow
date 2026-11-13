/**
 * `write`'s `move` and `delete`: host commands that change where a whole document
 * lives, not what it says. Each runs when called. Live, through the thread's live port,
 * links follow a move (#694) and a delete keeps every Work's drafts. In a draft-mode
 * chat, any move touching a drafted source is a fact in the Work's branch and live is untouched
 * until the writer applies it. Either way the tree entry commits in the mutation's own
 * transaction with a handle on the document's counter for this chat, so `undo`, `redo` and
 * `revert` walk it with the text edits, and a reply's rollback reverses it.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";
import {
  documentNotFoundMessage,
  modelResult,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { contextPortForThread } from "../../domains/context/context-port-resolution.js";
import { contextAreaOf } from "../../domains/context/index.js";
import type { AdapterDraftedChange } from "../../domains/context/ports/context-adapter.js";
import type { ContextError, FileRef } from "../../domains/context/ports/context-port.js";
import {
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { threadContainerTarget } from "../file-targets.js";
import { documentGrant, fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { namespaceContextRefusal, namespaceRefusal } from "./namespace-refusal.js";
import { removedPathError } from "./removed-path.js";
import {
  canonicalPath,
  isToolError,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

type MoveInput = Extract<WriteToolInput, { command: "move" }>;
type DeleteInput = Extract<WriteToolInput, { command: "delete" }>;
export type NamespaceInput = MoveInput | DeleteInput;

async function siblingPosition(
  call: ToolCall,
  input: MoveInput,
): Promise<
  import("@meridian/contracts/protocol").ContextSiblingPosition | WriteToolErrorOutput | undefined
> {
  if (!input.position) return undefined;
  if (input.position.kind === "start" || input.position.kind === "end")
    return { kind: input.position.kind };
  const trimmed = input.position.sibling.replace(/\/+$/, "");
  const folder = await folderAt(call, trimmed);
  if (!folder.ok)
    return namespaceContextRefusal("move", folder.error, { path: input.position.sibling });
  if (folder.value?.folderId)
    return { kind: input.position.kind, siblingId: folder.value.folderId };
  const sibling = await call.context.port.stat(input.position.sibling);
  if (!sibling.ok && sibling.error.code !== "not_found")
    return namespaceContextRefusal("move", sibling.error, { path: input.position.sibling });
  const documentId = sibling.ok ? sibling.value.documentId : undefined;
  if (!documentId)
    return namespaceRefusal("move", "document_unresolved", { path: input.position.sibling });
  return { kind: input.position.kind, siblingId: documentId };
}

/** The document a move or delete acts on, as the model named it. */
function sourcePath(input: NamespaceInput): string {
  return input.command === "move" ? input.from.path : input.path;
}

function committedLanding(landedAt: string | undefined, operation: string): string {
  if (!landedAt) throw new Error(`A committed ${operation} did not report its destination`);
  return landedAt;
}

/** The folder literally named by `path`, if its parent lists one; the written leaf wins over a document alias. */
async function folderAt(call: ToolCall, path: string) {
  const uri = path.includes("://") ? path : `manuscript://${path}`;
  const trimmed = uri.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const leaf = (value: string) => value.slice(value.lastIndexOf("/") + 1);
  const name = leaf(trimmed);
  if (!name || trimmed.endsWith(":")) return { ok: true as const, value: null };
  const listing = await call.context.port.list(trimmed.slice(0, slash + 1));
  if (!listing.ok) return listing;
  return {
    ok: true as const,
    value:
      listing.value.entries.find(
        (entry) => entry.kind === "directory" && leaf(entry.uri.replace(/\/+$/, "")) === name,
      ) ?? null,
  };
}

/** The document at the source path, in the version this chat's writes change. */
async function resolveSource(
  call: ToolCall,
  input: NamespaceInput,
): Promise<(FileRef & { documentId: DocumentId }) | WriteToolErrorOutput> {
  const path = sourcePath(input);
  const filePath = splitDocumentFile(path).filePath;
  const folder = await folderAt(call, filePath);
  if (folder.ok && folder.value)
    return namespaceRefusal(input.command, "source_is_folder", { path: filePath });
  const ref = await call.context.port.stat(filePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found")
      return writeToolError(
        input.command,
        documentNotFoundMessage(input.command),
        "document_not_found",
        {
          path,
        },
      );
    return namespaceContextRefusal(input.command, ref.error, { path });
  }
  if (!ref.value.documentId)
    return namespaceRefusal(input.command, "document_unresolved", { path });
  return { ...ref.value, documentId: ref.value.documentId as DocumentId };
}

/** Edit on the folder the move lands in; null when the path names no owner (the port says why). */
async function containerGrant(
  deps: ToolWiringDeps,
  call: ToolCall,
  path: string,
): Promise<FileGrant<"edit"> | WriteToolErrorOutput | null> {
  const target = await threadContainerTarget(deps.works, call.context.resolution, path);
  if (!target) return null;
  const grant = await deps.fileAccess.authorize(call.principal, target, "edit");
  return isFileAccessDenied(grant) ? fileAccessDeniedError("move", grant, path) : grant;
}

/**
 * The live move or delete, its tree entry recorded inside the mutation's own transaction. The
 * placement before is read just ahead of it. The port acts on the document by id, so a rename or
 * move by the writer in between does not fail the command: the document lands where the model
 * typed.
 */
async function commitLive(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: NamespaceInput,
  source: FileRef & { documentId: DocumentId },
  ctx: ToolHandlerContext,
): Promise<{ handle: string; uri: string } | WriteToolErrorOutput> {
  const port = contextPortForThread(deps.contextPorts, call.context.resolution, {
    responseId: ctx.responseIdentity?.editScopeId ?? null,
    liveWrites: true,
  });
  const history = deps.documentSync.treeHistory();
  const before = await history.liveState(source.documentId);
  const position = input.command === "move" ? await siblingPosition(call, input) : undefined;
  if (position && "output" in position) return position;
  if (!before?.living)
    return namespaceRefusal(input.command, "stale_location", { path: source.uri });
  const origin = {
    type: "agent" as const,
    agentSlug: ctx.agentSlug,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
  };
  let recorded: string | undefined;
  const record = async (landedAt?: string) => {
    const common = {
      documentId: source.documentId,
      threadId: ctx.threadId as ThreadId,
      ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
      ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      change: { destination: "live" as const, before },
      shownAt: source.uri,
    };
    recorded = (
      await (input.command === "move"
        ? history.recordAgentTreeChange({
            ...common,
            op: "move",
            landedAt: committedLanding(landedAt, "model move"),
          })
        : history.recordAgentTreeChange({ ...common, op: "delete" }))
    ).handle;
  };
  const refuse = (error: ContextError) =>
    namespaceContextRefusal(input.command, error, {
      path: source.uri,
      ...(input.command === "move" ? { destination: input.path } : {}),
    });
  if (input.command === "delete") {
    const deleted = await port.delete(
      { kind: "file", nodeId: source.documentId },
      contextAreaOf(source.uri),
      {
        origin,
        inTransaction: () => record(),
      },
    );
    if (!deleted.ok) return refuse(deleted.error);
    if (!recorded) throw new Error("A delete committed without its tree entry");
    return { handle: recorded, uri: source.uri };
  }
  // The port takes the folder and the leaf apart; the leaf is what the model typed.
  const typed = await canonicalPath(call, input.path);
  const slash = typed.lastIndexOf("/");
  const moved = await port.move(
    { kind: "file", nodeId: source.documentId },
    contextAreaOf(source.uri),
    {
      destination: { kind: "at", folderUri: typed.slice(0, slash + 1) },
      name: typed.slice(slash + 1),
      origin,
      ...(position ? { position } : {}),
      inTransaction: (result) => record(result.destinationUri),
    },
  );
  if (!moved.ok) return refuse(moved.error);
  // A destination naming the document where it already is moves nothing and records nothing.
  if (!recorded)
    return namespaceRefusal(input.command, "already_at_destination", {
      path: source.uri,
      destination: input.path,
    });
  return { handle: recorded, uri: moved.value.destinationUri };
}

/**
 * The drafted move or delete: records of the Work's branch, made through the chat's own
 * (draft-placed) port, with its tree entry recorded in the same transaction. Live is untouched.
 */
async function commitDrafted(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: NamespaceInput,
  source: FileRef & { documentId: DocumentId },
  ctx: ToolHandlerContext,
): Promise<{ handle: string; uri: string } | WriteToolErrorOutput> {
  const history = deps.documentSync.treeHistory();
  const threadId = ctx.threadId as ThreadId;
  const turnId = ctx.turnId ? (ctx.turnId as TurnId) : undefined;
  const position = input.command === "move" ? await siblingPosition(call, input) : undefined;
  if (position && "output" in position) return position;
  const origin = {
    type: "agent" as const,
    agentSlug: ctx.agentSlug,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
  };
  let recorded: string | undefined;
  const record = async (drafted: AdapterDraftedChange | undefined, landedAt?: string) => {
    if (!drafted) throw new Error(`A drafted ${input.command} reported no branch change`);
    const common = {
      documentId: source.documentId,
      threadId,
      ...(turnId ? { turnId } : {}),
      ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      change: { destination: "draft" as const, ...drafted },
      shownAt: source.uri,
    };
    recorded = (
      await (input.command === "move"
        ? history.recordAgentTreeChange({
            ...common,
            op: "move",
            landedAt: committedLanding(landedAt, "drafted move"),
          })
        : history.recordAgentTreeChange({ ...common, op: "delete" }))
    ).handle;
  };
  const node = { kind: "file" as const, nodeId: source.documentId };
  const area = contextAreaOf(source.uri);
  const refuse = (error: ContextError) =>
    namespaceContextRefusal(input.command, error, {
      path: source.uri,
      ...(input.command === "move" ? { destination: input.path } : {}),
    });
  if (input.command === "delete") {
    const deleted = await call.context.port.delete(node, area, {
      origin,
      drafted: true,
      inTransaction: (result) => record(result.drafted),
    });
    if (!deleted.ok) return refuse(deleted.error);
    if (!recorded) throw new Error("A drafted delete committed without its tree entry");
    return { handle: recorded, uri: source.uri };
  }
  const typed = await canonicalPath(call, input.path);
  const slash = typed.lastIndexOf("/");
  const moved = await call.context.port.move(node, area, {
    destination: { kind: "at", folderUri: typed.slice(0, slash + 1) },
    name: typed.slice(slash + 1),
    origin,
    drafted: true,
    ...(position ? { position } : {}),
    inTransaction: (result) => record(result.drafted, result.destinationUri),
  });
  if (!moved.ok) return refuse(moved.error);
  if (!recorded)
    return namespaceRefusal(input.command, "already_at_destination", {
      path: source.uri,
      destination: input.path,
    });
  return { handle: recorded, uri: moved.value.destinationUri };
}

/**
 * `move` needs edit on the document and on the folder it lands in; `delete`, edit on the
 * document. Agents only read uploads. A move touching a drafted namespace lands as
 * one drafted move, including moves to or from live Scratch. No frontier check.
 */
export async function runNamespaceCommand(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: NamespaceInput,
  ctx: ToolHandlerContext,
) {
  const source = await resolveSource(call, input);
  if (isToolError(source)) {
    const removed =
      source.output.status === "document_not_found"
        ? await removedPathError(deps, call, input.command, sourcePath(input), ctx.threadId)
        : null;
    return removed ?? source;
  }
  const grant = await documentGrant(
    deps,
    call.principal,
    input.command,
    { documentId: source.documentId, filePath: source.uri },
    "edit",
  );
  if (isToolError(grant)) return grant;
  const grants: FileGrant<"edit">[] = [grant];
  let drafted = grant.destination.kind === "draft";
  let draftDestination = grant.destination.kind === "draft" ? grant.destination : null;
  if (input.command === "move") {
    const container = await containerGrant(deps, call, input.path);
    if (isToolError(container)) return container;
    if (container) {
      grants.push(container);
      if (container.destination.kind === "draft") draftDestination = container.destination;
      drafted ||= container.destination.kind === "draft";
    }
  }
  const result = await runWithEditGrants(deps.fileAccess, grants, () =>
    drafted
      ? commitDrafted(deps, call, input, source, ctx)
      : commitLive(deps, call, input, source, ctx),
  );
  if (!result.ok)
    return fileAccessDeniedError(input.command, firstRefusal(result.refusal), source.uri);
  if (isToolError(result.value)) return result.value;
  const { handle, uri } = result.value;
  // A drafted delete leaves live and every Work's drafts alone: nothing outlives anything.
  const survivingWorks =
    input.command === "delete" && !drafted
      ? await deps.documentSync.treeHistory().survivingDraftWorks(source.documentId)
      : [];
  const destination = drafted ? draftDestination : grant.destination;
  if (!destination) throw new Error("A drafted namespace command has no Work destination");
  return {
    output: modelResult({
      command: input.command,
      status: "success",
      phase: "committed",
      payload: {
        path: uri,
        destination: destination.kind,
        ...(destination.kind === "draft" ? { draftWork: destination.ownerHandle ?? "/" } : {}),
        write: { id: handle },
        namespace:
          input.command === "move"
            ? { kind: "moved", from: source.uri }
            : { kind: "deleted", ...(survivingWorks.length ? { survivingWorks } : {}) },
      },
    }),
    // Committed at the call: a save boundary after it rotates the reply's edit scope.
    metadata: { treeWrite: true, documentId: source.documentId },
  };
}
