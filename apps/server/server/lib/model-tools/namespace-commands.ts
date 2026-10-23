/**
 * `write`'s `move` and `delete` (D25, D38): host commands that change where a whole document
 * lives, not what it says. Each runs when called (D66). Live, through the thread's live port,
 * links follow a move (#694) and a delete keeps every Work's drafts (D79). In a draft-mode
 * chat, any move touching a drafted source is a fact in the Work's branch and live is untouched
 * until the writer applies it (D26, D45). Either way the tree entry commits in the mutation's own
 * transaction with a handle on the document's counter for this chat, so `undo`, `redo` and
 * `revert` walk it with the text edits (D76), and a reply's rollback reverses it.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";
import {
  documentNotFoundMessage,
  modelResult,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import { formatParsedContextUri, parseContextUri } from "@meridian/contracts/context-uri";
import { type ContextMoveResult, renderFilename } from "@meridian/contracts/protocol";
import { contextPortForThread } from "../../domains/context/context-port-resolution.js";
import type { RecordedBranchTreeChange } from "../../domains/context/ports/branch-tree.js";
import type {
  ContextError,
  ContextPort,
  FileRef,
} from "../../domains/context/ports/context-port.js";
import {
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { threadContainerTarget } from "../file-targets.js";
import { documentGrant, fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { namespaceContextRefusal, namespaceRefusal } from "./namespace-refusal.js";
import {
  canonicalPath,
  isToolError,
  recordTouchInBackground,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

type MoveInput = Extract<WriteToolInput, { command: "move" }>;
type DeleteInput = Extract<WriteToolInput, { command: "delete" }>;
export type NamespaceInput = MoveInput | DeleteInput;

/** The document a move or delete acts on, as the model named it. */
function sourcePath(input: NamespaceInput): string {
  return input.command === "move" ? input.from.path : input.path;
}

/** Whether `uri` names a folder: its parent lists a folder by that name. */
async function isFolder(port: ContextPort, uri: string): Promise<boolean> {
  const trimmed = uri.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!name || trimmed.endsWith(":/")) return false;
  const listing = await port.list(trimmed.slice(0, trimmed.length - name.length));
  return (
    listing.ok &&
    listing.value.entries.some(
      (entry) => entry.kind === "directory" && entry.uri.replace(/\/+$/, "").endsWith(`/${name}`),
    )
  );
}

/** The document at the source path, in the version this chat's writes change. */
async function resolveSource(
  call: ToolCall,
  input: NamespaceInput,
): Promise<(FileRef & { documentId: DocumentId }) | WriteToolErrorOutput> {
  const path = sourcePath(input);
  const filePath = splitDocumentFile(path).filePath;
  const ref = await call.context.port.stat(filePath);
  if (!ref.ok) {
    if (ref.error.code === "not_found" && (await isFolder(call.context.port, filePath)))
      return namespaceRefusal(input.command, "source_is_folder", { path: filePath });
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
 * placement before is read just ahead of it: the port's own check (the document still at the
 * source path) fails the command if it moved in between.
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
  const wantedAt = input.command === "move" ? await canonicalPath(call, input.path) : undefined;
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
    recorded = (
      await history.recordAgentTreeChange({
        documentId: source.documentId,
        threadId: ctx.threadId as ThreadId,
        ...(ctx.turnId ? { turnId: ctx.turnId as TurnId } : {}),
        ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        op: input.command,
        change: { destination: "live", before },
        shownAt: source.uri,
        ...(landedAt ? { landedAt } : {}),
      })
    ).handle;
  };
  const refuse = (error: ContextError) =>
    namespaceContextRefusal(input.command, error, {
      path: source.uri,
      ...(input.command === "move" ? { destination: input.path } : {}),
    });
  if (input.command === "delete") {
    const deleted = await port.delete(source.uri, {
      expected: { kind: "file", documentId: source.documentId },
      origin,
      inTransaction: () => record(),
    });
    if (!deleted.ok) return refuse(deleted.error);
    if (!recorded) throw new Error("A delete committed without its tree entry");
    return { handle: recorded, uri: source.uri };
  }
  const moved = await port.commitWriterLocation(source.uri, input.path, {
    expected: { kind: "file", nodeId: source.documentId },
    origin,
    inTransaction: async (result: ContextMoveResult) => {
      const wanted = wantedAt ? parseContextUri(wantedAt) : null;
      const landedAt = result.destinationUri
        ? result.destinationUri
        : wanted?.ok
          ? formatParsedContextUri(
              wanted.value.scheme,
              result.destinationPath,
              wanted.value.authority,
            )
          : input.path;
      await record(landedAt);
    },
  });
  if (!moved.ok) return refuse(moved.error);
  // A destination naming the document where it already is moves nothing and records nothing.
  if (!recorded)
    return namespaceRefusal(input.command, "already_at_destination", {
      path: source.uri,
      destination: input.path,
    });
  const wanted = wantedAt ? parseContextUri(wantedAt) : null;
  const uri = moved.value.destinationUri
    ? moved.value.destinationUri
    : wanted?.ok
      ? formatParsedContextUri(
          wanted.value.scheme,
          moved.value.destinationPath,
          wanted.value.authority,
        )
      : input.path;
  return { handle: recorded, uri };
}

/**
 * The drafted move or delete: the branch's facts, through the chat's own (draft-placed) port,
 * with its tree entry recorded in the same transaction. Never the mover; live is untouched.
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
  const wantedAt = input.command === "move" ? await canonicalPath(call, input.path) : undefined;
  let recorded: string | undefined;
  const record = async (change: RecordedBranchTreeChange) => {
    const moved = change.after.moved;
    const wanted = wantedAt ? parseContextUri(wantedAt) : null;
    const landedAt =
      moved && wanted?.ok
        ? formatParsedContextUri(
            wanted.value.scheme,
            [
              ...wanted.value.path.split("/").slice(0, -1),
              renderFilename(moved.name, moved.extension),
            ].join("/"),
            wanted.value.authority,
          )
        : undefined;
    recorded = (
      await history.recordAgentTreeChange({
        documentId: source.documentId,
        threadId,
        ...(turnId ? { turnId } : {}),
        ...(ctx.responseIdentity ? { responseIdentity: ctx.responseIdentity } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        op: input.command,
        change: { destination: "draft", ...change },
        shownAt: source.uri,
        ...(landedAt ? { landedAt } : {}),
      })
    ).handle;
  };
  const command = {
    documentId: source.documentId,
    changedBy: { threadId, ...(turnId ? { turnId } : {}) },
    record,
  };
  const changed = await call.context.port.changeInBranch(
    input.command === "move"
      ? { ...command, op: "move", sourceUri: source.uri, destinationUri: input.path }
      : { ...command, op: "delete", uri: source.uri },
  );
  if (!changed.ok)
    return namespaceContextRefusal(input.command, changed.error, {
      path: source.uri,
      ...(input.command === "move" ? { destination: input.path } : {}),
    });
  if (input.command === "move" && !changed.value.moved)
    return namespaceRefusal(input.command, "already_at_destination", {
      path: source.uri,
      destination: input.path,
    });
  if (!recorded) throw new Error(`A drafted ${input.command} committed without its tree entry`);
  return { handle: recorded, uri: changed.value.uri };
}

/**
 * `move` needs edit on the document and on the folder it lands in; `delete`, edit on the
 * document. Agents only read uploads (D11, D15). A move touching a drafted namespace lands as
 * one drafted move, including moves to or from live Scratch (D45). No frontier check (D78).
 */
export async function runNamespaceCommand(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: NamespaceInput,
  ctx: ToolHandlerContext,
) {
  const source = await resolveSource(call, input);
  if (isToolError(source)) return source;
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
  recordTouchInBackground(deps, source.documentId, ctx);
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
        ...(destination.kind === "draft" ? { draftWork: destination.workHandle ?? "/" } : {}),
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
