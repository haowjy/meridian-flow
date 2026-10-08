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
  writeHandle,
} from "@meridian/agent-edit/integration";
import type { ContextPort, FileRef } from "../../domains/context/ports/context-port.js";
import {
  type FileDestination,
  type FileGrant,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { Err, Ok, type Result } from "../../shared/result.js";
import { threadContainerTarget } from "../file-targets.js";
import { documentGrant, fileAccessDeniedError, firstRefusal } from "./file-access.js";
import { namespaceContextRefusal, namespaceRefusal } from "./namespace-refusal.js";
import {
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

async function resolveSource(
  call: ToolCall,
  input: NamespaceInput,
): Promise<(FileRef & { documentId: string }) | WriteToolErrorOutput> {
  const path = sourcePath(input);
  const filePath = splitDocumentFile(path).filePath;
  const ref = await call.context.port.stat(filePath);
  if (!ref.ok && ref.error.code === "not_found" && (await isFolder(call.context.port, filePath))) {
    return namespaceRefusal(input.command, filePath, "source_is_folder");
  }
  if (!ref.ok) {
    return ref.error.code === "not_found"
      ? writeToolError(
          input.command,
          aboutSource(input, documentNotFoundMessage(input.command)),
          "document_not_found",
          { path },
        )
      : namespaceContextRefusal(input.command, ref.error);
  }
  const { documentId } = ref.value;
  if (!documentId) return writeToolError(input.command, `Document id missing for ${path}`);
  return { ...ref.value, documentId };
}

/** A Work as model-facing copy names it: `@slug`, or No Work. */
function workName(slug: string | null): string {
  return slug ? `@${slug}` : "No Work";
}

/**
 * A draft-mode Work holds every change to the project's files, but a draft
 * can't hold a move or delete yet, so the change isn't made.
 */
function draftRefusal(
  command: DocumentCommandName,
  doing: string,
  destinations: readonly FileDestination[],
): WriteToolErrorOutput | undefined {
  const draft = destinations.find((destination) => destination.kind === "draft");
  if (draft?.kind !== "draft") return undefined;
  return writeToolError(
    command,
    `${doing} in ${workName(draft.workSlug)}'s draft isn't supported yet, so nothing changed.`,
  );
}

/**
 * A move between a drafted file and a live one would land half in a draft
 * and half live, so it's refused, naming what would let it through (D45).
 */
function mixedMoveRefusal(
  source: FileDestination,
  container: FileDestination | undefined,
): WriteToolErrorOutput | undefined {
  if (!container || source.kind === container.kind) return undefined;
  const draft = source.kind === "draft" ? source : container;
  if (draft.kind !== "draft") return undefined;
  const work = workName(draft.workSlug);
  return writeToolError(
    "move",
    `${work} is in draft mode, so this move would be half drafted and half live. Copy the document, then delete the original, or ask the user to switch ${work} to auto-apply.`,
  );
}

/** Edit on the folder `uri` lands in; null when the path names no Work or scheme (the port says which). */
export async function containerGrant(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: DocumentCommandName,
  uri: string,
  principal: Principal = call.principal,
): Promise<FileGrant<"edit"> | WriteToolErrorOutput | null> {
  const target = await threadContainerTarget(deps.works, call.context.resolution, uri);
  if (!target) return null;
  const container = await deps.fileAccess.authorize(principal, target, "edit");
  return isFileAccessDenied(container) ? fileAccessDeniedError(command, container, uri) : container;
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

type Committed = Result<
  { kind: "move"; fromUri: string; toUri: string } | { kind: "delete"; fromUri: string },
  WriteToolErrorOutput
>;

/** The move itself, to the exact path; the change records where it landed. */
async function commitMove(
  call: ToolCall,
  input: MoveInput,
  source: FileRef & { documentId: string },
): Promise<Committed> {
  const port = call.context.livePort();
  const moved = await port.commitWriterLocation(source.uri, input.path, {
    expected: { kind: "file", nodeId: source.documentId },
    linksSettled: true,
  });
  if (!moved.ok) return Err(namespaceContextRefusal(input.command, moved.error));
  const landed = await port.stat(input.path);
  if (!landed.ok) return Err(namespaceContextRefusal(input.command, landed.error));
  if (landed.value.uri === source.uri) {
    return Err(namespaceRefusal(input.command, input.path, "already_at_destination"));
  }
  return Ok({ kind: "move", fromUri: source.uri, toUri: landed.value.uri });
}

async function commitDelete(
  call: ToolCall,
  input: DeleteInput,
  source: FileRef & { documentId: string },
): Promise<Committed> {
  const deleted = await call.context
    .livePort()
    .delete(source.uri, { expected: { kind: "file", documentId: source.documentId } });
  if (!deleted.ok) {
    return Err(namespaceContextRefusal(input.command, deleted.error));
  }
  return Ok({ kind: "delete", fromUri: source.uri });
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
    const mixed = mixedMoveRefusal(grant.destination, container?.destination);
    if (mixed) return mixed;
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

  if (input.command === "move") await call.context.livePort().settleLinks([source.uri]);

  const committed = await underGrants(deps, input.command, sourcePath(input), grants, () =>
    deps.documentSync.namespaceChanges.commit(
      {
        documentId: source.documentId,
        threadId: ctx.threadId,
        turnId: ctx.turnId ?? null,
        draftBranchId: null,
      },
      () =>
        input.command === "move"
          ? commitMove(call, input, source)
          : commitDelete(call, input, source),
    ),
  );
  if (isToolError(committed)) return committed;
  if (!committed.ok) return committed.error;
  const change = committed.value;
  if (ctx.responseId !== undefined) {
    deps.responseWrites.trackStagedNamespaceChange({
      responseId: ctx.responseId,
      port: call.context.livePort(),
      change,
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
        write: { id: writeHandle(change.wId) },
        namespace:
          input.command === "move" ? { kind: "moved", from: input.from.path } : { kind: "deleted" },
      },
    }),
    // A change the reply can still roll back: an undo or redo saves the reply first. The
    // document id is what the writer's restore of a delete names (POST …/turns/:turnId/restore-delete).
    metadata: { stagedNamespaceChange: true, documentId: source.documentId },
  };
}
