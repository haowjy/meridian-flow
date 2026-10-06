/**
 * `write`'s `move` and `delete` (D25, D38): host commands that change where a
 * whole document lives, not what it says. Each commits when called through
 * the thread's live port, so links follow a move (#694) and the live manifest
 * drops a delete, and is reversed if its reply rolls back (D66). Each gets a
 * write handle on the document's sequence.
 */
import type { DocumentCommandName, WriteToolInput } from "@meridian/agent-edit/integration";
import {
  documentNotFoundMessage,
  modelResult,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import type {
  ContextError,
  ContextPort,
  FileRef,
} from "../../domains/context/ports/context-port.js";
import {
  type FileDestination,
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import type { Result } from "../../shared/result.js";
import { threadContainerTarget } from "../file-targets.js";
import { documentGrant, fileAccessDeniedError, firstRefusal } from "./file-access.js";
import {
  contextErrorMessage,
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

export function isNamespaceCommand(input: WriteToolInput): input is NamespaceInput {
  return input.command === "move" || input.command === "delete";
}

/** The document a move or delete acts on, as the model named it. */
function sourcePath(input: NamespaceInput): string {
  return input.command === "move" ? input.from.path : input.path;
}

/** Errors about a move's source say so, since `path` names where it goes. */
function aboutSource(input: NamespaceInput, message: string): string {
  return input.command === "move" ? `from ${input.from.path}: ${message}` : message;
}

async function resolveSource(
  call: ToolCall,
  input: NamespaceInput,
): Promise<(FileRef & { documentId: string }) | WriteToolErrorOutput> {
  const path = sourcePath(input);
  const ref = await call.context.port.stat(splitDocumentFile(path).filePath);
  if (!ref.ok) {
    return ref.error.code === "not_found"
      ? writeToolError(
          input.command,
          aboutSource(input, documentNotFoundMessage(input.command)),
          "document_not_found",
          { path },
        )
      : writeToolError(input.command, aboutSource(input, contextErrorMessage(ref.error)));
  }
  const { documentId } = ref.value;
  if (!documentId) return writeToolError(input.command, `Document id missing for ${path}`);
  return { ...ref.value, documentId };
}

/**
 * A draft-mode Work holds every change to the project's files, but a draft
 * can't hold a move or delete yet, so the change isn't made.
 */
export function draftRefusal(
  command: DocumentCommandName,
  doing: string,
  destinations: readonly FileDestination[],
): WriteToolErrorOutput | undefined {
  const draft = destinations.find((destination) => destination.kind === "draft");
  if (draft?.kind !== "draft") return undefined;
  return writeToolError(
    command,
    `${doing} in @${draft.workSlug ?? "/"}'s draft isn't supported yet, so nothing changed.`,
  );
}

/** Edit on the folder `uri` lands in; null when the path names no Work or scheme (the port says which). */
export async function containerGrant(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: DocumentCommandName,
  uri: string,
): Promise<FileGrant<"edit"> | WriteToolErrorOutput | null> {
  const target = await threadContainerTarget(deps.works, call.context.resolution, uri);
  if (!target) return null;
  const container = await deps.fileAccess.authorize(call.principal, target, "edit");
  return isFileAccessDenied(container) ? fileAccessDeniedError(command, container, uri) : container;
}

function namespaceErrorMessage(input: NamespaceInput, error: ContextError): string {
  switch (error.code) {
    case "conflict":
      return `${input.path} already exists. Choose another path.`;
    case "stale_source":
    case "stale_target":
      return aboutSource(
        input,
        "The document changed while this ran. Check the path and try again.",
      );
    default:
      return contextErrorMessage(error);
  }
}

/** Runs `operation` under the grants; a seam's refusal under its locks is the tool's error. */
export async function underGrants<T>(
  deps: ToolWiringDeps,
  command: DocumentCommandName,
  path: string,
  grants: FileGrant<"edit">[],
  operation: () => Promise<T>,
): Promise<T | WriteToolErrorOutput> {
  const result = await runWithEditGrants(deps.fileAccess, grants, operation);
  return result.ok
    ? result.value
    : fileAccessDeniedError(command, firstRefusal(result.refusal), path);
}

/** A recorded move or delete, enough to apply it either way. */
export type NamespaceChangeShape =
  | { kind: "move"; fromUri: string; toUri: string }
  | { kind: "delete"; fromUri: string };

/**
 * Applies a move or delete (`redo`) or puts the document back (`undo`), on a
 * live port: a move goes through `ContextTreeMover` so links follow (#694),
 * and an undone delete is restored where it was.
 */
export function applyNamespaceChange(
  port: ContextPort,
  documentId: string,
  change: NamespaceChangeShape,
  direction: "undo" | "redo",
): Promise<Result<unknown, ContextError>> {
  if (change.kind === "move") {
    const [from, to] =
      direction === "undo" ? [change.toUri, change.fromUri] : [change.fromUri, change.toUri];
    return port.commitWriterLocation(from, to, { expected: { kind: "file", nodeId: documentId } });
  }
  return direction === "undo"
    ? port.restore(change.fromUri, { documentId })
    : port.delete(change.fromUri, { expected: { kind: "file", documentId } });
}

type Committed = NamespaceChangeShape;

async function commitMove(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: MoveInput,
  source: FileRef & { documentId: string },
  grants: FileGrant<"edit">[],
): Promise<Committed | WriteToolErrorOutput> {
  const port = call.context.livePort();
  const moved = await underGrants(deps, input.command, input.from.path, grants, () =>
    port.commitWriterLocation(source.uri, input.path, {
      expected: { kind: "file", nodeId: source.documentId },
    }),
  );
  if (isToolError(moved)) return moved;
  if (!moved.ok) return writeToolError(input.command, namespaceErrorMessage(input, moved.error));
  const landed = await port.stat(input.path);
  if (!landed.ok) return writeToolError(input.command, contextErrorMessage(landed.error));
  if (landed.value.uri === source.uri) {
    return writeToolError(input.command, `The document is already at ${input.path}.`);
  }
  return { kind: "move", fromUri: source.uri, toUri: landed.value.uri };
}

async function commitDelete(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: DeleteInput,
  source: FileRef & { documentId: string },
  grants: FileGrant<"edit">[],
): Promise<Committed | WriteToolErrorOutput> {
  const deleted = await underGrants(deps, input.command, input.path, grants, () =>
    call.context
      .livePort()
      .delete(source.uri, { expected: { kind: "file", documentId: source.documentId } }),
  );
  if (isToolError(deleted)) return deleted;
  if (!deleted.ok)
    return writeToolError(input.command, namespaceErrorMessage(input, deleted.error));
  return { kind: "delete", fromUri: source.uri };
}

/**
 * `move` needs edit on the document and on the folder it lands in; `delete`
 * needs edit on the document. Agents can only read uploads, so neither
 * touches one (D11, D15). The model's last read must be of the version the
 * change lands in (D41).
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
    { documentId: source.documentId, filePath: sourcePath(input) },
    "edit",
  );
  if (isToolError(grant)) return grant;
  const grants: FileGrant<"edit">[] = [grant];
  if (input.command === "move") {
    const container = await containerGrant(deps, call, input.command, input.path);
    if (isToolError(container)) return container;
    if (container) grants.push(container);
  }
  const refused = draftRefusal(
    input.command,
    `${input.command === "move" ? "Moving" : "Deleting"} documents`,
    grants.map((granted) => granted.destination),
  );
  if (refused) return refused;
  const stale = deps.documentSync.agentEdit().requireCurrentRead({
    threadId: ctx.threadId,
    documentId: source.documentId,
    command: input.command,
    path: sourcePath(input),
    destination: grant.destination,
  });
  if (stale) return { isError: true, output: stale.result };

  const committed =
    input.command === "move"
      ? await commitMove(deps, call, input, source, grants)
      : await commitDelete(deps, call, input, source, grants);
  if (isToolError(committed)) return committed;

  let record: Awaited<ReturnType<ToolWiringDeps["namespaceChanges"]["record"]>>;
  try {
    record = await deps.namespaceChanges.record({
      documentId: source.documentId,
      threadId: ctx.threadId,
      turnId: ctx.turnId ?? null,
      responseId: ctx.responseId ?? null,
      ...committed,
    });
  } catch (cause) {
    await applyNamespaceChange(call.context.livePort(), source.documentId, committed, "undo");
    throw cause;
  }
  if (ctx.responseId !== undefined) {
    deps.responseWrites.trackStagedNamespaceChange({
      responseId: ctx.responseId,
      port: call.context.livePort(),
      documentId: source.documentId,
      recordId: record.id,
      ...committed,
    });
  }
  recordTouchInBackground(deps, source.documentId, ctx);
  return {
    output: modelResult({
      command: input.command,
      status: "success",
      phase: "committed",
      payload: {
        path: input.path,
        destination: "live",
        write: { id: record.handle },
        namespace:
          input.command === "move" ? { kind: "moved", from: input.from.path } : { kind: "deleted" },
      },
    }),
    // A change the reply can still roll back: an undo or redo saves the reply first. The
    // document id is what the writer's restore of a delete names (POST …/turns/:turnId/restore-delete).
    metadata: { stagedNamespaceChange: true, documentId: source.documentId },
  };
}
