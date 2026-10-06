/**
 * `write`'s `undo` and `redo` across both kinds of write handle (D66). A
 * document's moves and deletes go back, or again, through the same live
 * calls the commands made, so links follow a move back (#694) and an undone
 * delete is restored; its content writes go to the engine. An undo that
 * reverses the copy that made a document deletes the copy, and the redo of
 * that copy brings it back. A document with neither runs as before.
 */
import type {
  AgentEditResultV1,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import { modelResult, splitDocumentFile, writeHandle } from "@meridian/agent-edit/integration";
import type {
  NamespaceChangeRecord,
  WriteHandleHistory,
} from "../../domains/collab/domain/ports/agent-namespace-changes.js";
import type { ContextError, ContextPort } from "../../domains/context/ports/context-port.js";
import type { FileGrant } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { documentGrant } from "./file-access.js";
import {
  applyNamespaceChange,
  containerGrant,
  draftRefusal,
  underGrants,
} from "./namespace-commands.js";
import { planNamespaceReversal, type ReversalFields } from "./namespace-reversal-plan.js";
import {
  contextErrorMessage,
  documentRevisionMetadata,
  isToolError,
  type ResolvedDocumentAddress,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

type ReversalInput = Extract<WriteToolInput, { command: "undo" | "redo" }>;
type Direction = ReversalInput["command"];
type ContentOutcome = (WriteOutcome & { isError: false }) | WriteToolErrorOutput;

/** The engine's half: where a path is, and an undo or redo of the document's content writes. */
export interface ContentReversal {
  resolve(path: string): Promise<ResolvedDocumentAddress | WriteToolErrorOutput>;
  run(address: ResolvedDocumentAddress, fields: ReversalFields): Promise<ContentOutcome>;
}

/** Where the document is as the reversal goes: live at `uri`, or deleted from it. */
type Location = { live: boolean; uri: string };

function selectorFields(input: ReversalInput): ReversalFields {
  return {
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.last !== undefined ? { last: input.last } : {}),
    ...(input.all !== undefined ? { all: input.all } : {}),
  };
}

const verb = (direction: Direction) => (direction === "undo" ? "undo" : "redo");

function changeErrorMessage(
  direction: Direction,
  change: NamespaceChangeRecord,
  destination: string,
  error: ContextError,
): string {
  const lead = `Can't ${verb(direction)} ${writeHandle(change.wId)}`;
  switch (error.code) {
    case "conflict":
      return `${lead}: ${destination} already exists. Move or rename that document first.`;
    case "not_found":
      return change.kind === "delete" && direction === "undo"
        ? `${lead}: the folder it was in is gone.`
        : `${lead}: the document is no longer where ${writeHandle(change.wId)} left it.`;
    case "stale_source":
    case "stale_target":
      return `${lead}: the document is no longer where ${writeHandle(change.wId)} left it.`;
    default:
      return `${lead}: ${contextErrorMessage(error)}`;
  }
}

/** Where a change sends the document: the folder it needs edit on. */
function changeDestination(direction: Direction, change: NamespaceChangeRecord): string | null {
  if (change.kind === "move") return direction === "undo" ? change.fromUri : change.toUri;
  return direction === "undo" ? change.fromUri : null;
}

function nextLocation(direction: Direction, change: NamespaceChangeRecord): Location {
  if (change.kind === "move") {
    return { live: true, uri: direction === "undo" ? change.fromUri : change.toUri };
  }
  return { live: direction === "undo", uri: change.fromUri };
}

function namespaceFact(start: Location, end: Location): AgentEditResultV1["namespace"] {
  if (start.live && !end.live) return { kind: "deleted" };
  if (!start.live && end.live) return { kind: "restored" };
  return start.uri === end.uri ? undefined : { kind: "moved", from: start.uri };
}

function withNote<T extends { isError: true; output: AgentEditResultV1 }>(error: T, note: string) {
  if (!note) return error;
  const message = error.output.message ? `${error.output.message} ${note}` : note;
  return { ...error, output: { ...error.output, message } };
}

async function isEmptyDocument(port: ContextPort, uri: string): Promise<boolean> {
  const read = await port.read(uri);
  return read.ok && read.value.content.trim() === "";
}

/**
 * The undo just reversed the copy that made this document, and nothing this
 * thread wrote into it since: the copy goes. The copy is the thread's first
 * content write on a document it copied in.
 */
function undidTheCopy(history: WriteHandleHistory, reversed: readonly string[]): number | null {
  if (!history.copied) return null;
  const first = history.content[0];
  if (!first) return null;
  const undone = new Set(reversed);
  if (!undone.has(writeHandle(first.wId))) return null;
  const left = history.content.filter(
    (handle) => handle.status === "active" && !undone.has(writeHandle(handle.wId)),
  );
  return left.length === 0 ? first.wId : null;
}

export async function runReversal(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: ReversalInput,
  ctx: ToolHandlerContext,
  content: ContentReversal,
) {
  const direction = input.command;
  const fields = selectorFields(input);
  const resolved = await content.resolve(input.path);
  let documentId: string;
  let start: Location;
  if (isToolError(resolved)) {
    // A deleted document has no path to resolve; this thread's delete or discarded copy names it.
    if (resolved.output.status !== "document_not_found") return resolved;
    const deleted = await deps.namespaceChanges.findDeletedAt(
      ctx.threadId,
      splitDocumentFile(input.path).filePath,
    );
    if (!deleted) return resolved;
    documentId = deleted.documentId;
    start = { live: false, uri: deleted.fromUri };
  } else {
    documentId = resolved.documentId;
    start = { live: true, uri: resolved.uri };
  }

  const history = await deps.namespaceChanges.history(documentId, ctx.threadId);
  if (!isToolError(resolved) && history.namespace.length === 0 && !history.copied) {
    return finishContent(deps, ctx, resolved, await content.run(resolved, fields));
  }

  const plan = planNamespaceReversal(direction, fields, history);
  if (!plan.ok) return writeToolError(direction, plan.message, plan.status, { path: input.path });
  const restoreCopy =
    direction === "redo" && !start.live && history.discardedCopy !== null && plan.content !== null
      ? history.discardedCopy
      : null;
  const undeletes = direction === "undo" && plan.namespace[0]?.kind === "delete";
  if (!start.live && !restoreCopy && !undeletes) {
    const blocker = history.namespace.find(
      (change) => change.kind === "delete" && change.status === "active",
    );
    const handle = blocker ? writeHandle(blocker.wId) : "the delete";
    return writeToolError(
      direction,
      `${input.path} is deleted, so its other writes can't be ${direction === "undo" ? "undone" : "redone"}. Undo ${handle} first.`,
      "invalid_write",
      { path: input.path },
    );
  }

  // Edit on the document if it's there, and on every folder a change puts it in.
  const grants: FileGrant<"edit">[] = [];
  if (start.live) {
    const grant = await documentGrant(
      deps,
      call.principal,
      direction,
      { documentId, filePath: input.path },
      "edit",
    );
    if (isToolError(grant)) return grant;
    grants.push(grant);
  }
  const destinations = new Set(
    plan.namespace.flatMap((change) => changeDestination(direction, change) ?? []),
  );
  if (restoreCopy) destinations.add(restoreCopy.fromUri);
  for (const uri of destinations) {
    const grant = await containerGrant(deps, call, direction, uri);
    if (isToolError(grant)) return grant;
    if (grant) grants.push(grant);
  }
  if (plan.namespace.length > 0 || restoreCopy) {
    const refused = draftRefusal(
      direction,
      direction === "undo" ? "Undoing moves and deletes" : "Redoing moves and deletes",
      grants.map((grant) => grant.destination),
    );
    if (refused) return refused;
  }

  const port = call.context.livePort();
  let location = start;
  const done: string[] = [];
  const doneNote = () =>
    done.length === 0 ? "" : `${direction === "undo" ? "Undone" : "Redone"}: ${done.join(", ")}.`;

  const applyChanges = async (): Promise<WriteToolErrorOutput | null> => {
    for (const change of plan.namespace) {
      const handle = writeHandle(change.wId);
      const from = direction === "undo" ? "active" : "reversed";
      if (!(await deps.namespaceChanges.transition(change.id, from))) {
        return withNote(
          writeToolError(
            direction,
            `${handle} was already ${direction === "undo" ? "undone" : "redone"}.`,
          ),
          doneNote(),
        );
      }
      const applied = await applyNamespaceChange(port, documentId, change, direction);
      if (!applied.ok) {
        await deps.namespaceChanges.transition(
          change.id,
          from === "active" ? "reversed" : "active",
        );
        const destination = changeDestination(direction, change) ?? change.fromUri;
        return withNote(
          writeToolError(
            direction,
            changeErrorMessage(direction, change, destination, applied.error),
          ),
          doneNote(),
        );
      }
      done.push(handle);
      location = nextLocation(direction, change);
    }
    return null;
  };

  // Undo walks back newest first, so the namespace part goes before the content; redo after it.
  if (direction === "undo") {
    const failed = await underGrants(deps, direction, input.path, grants, applyChanges);
    if (failed) return failed;
  } else if (restoreCopy) {
    const restored = await underGrants(deps, direction, input.path, grants, () =>
      port.restore(restoreCopy.fromUri, { documentId }),
    );
    if (isToolError(restored)) return restored;
    if (!restored.ok) {
      return writeToolError(
        direction,
        restored.error.code === "conflict"
          ? `Can't redo ${writeHandle(restoreCopy.wId)}: ${restoreCopy.fromUri} already exists. Move or rename that document first.`
          : `Can't redo ${writeHandle(restoreCopy.wId)}: ${contextErrorMessage(restored.error)}`,
      );
    }
    location = { live: true, uri: restoreCopy.fromUri };
  }

  let outcome: ContentOutcome | null = null;
  let address: ResolvedDocumentAddress | null = null;
  if (plan.content) {
    const at = await content.resolve(location.uri);
    if (isToolError(at)) return withNote(at, doneNote());
    address = at;
    outcome = await content.run(at, plan.content);
    if (restoreCopy) {
      const redone = isToolError(outcome) ? undefined : outcome.result.reversal?.writes;
      if (!redone?.includes(writeHandle(restoreCopy.wId))) {
        // The copy's own write didn't come back, so neither does the copy.
        await port.delete(location.uri, { expected: { kind: "file", documentId } });
        location = start;
      } else {
        await deps.namespaceChanges.forgetDiscardedCopy(restoreCopy.id);
      }
    }
    if (isToolError(outcome)) return withNote(outcome, doneNote());
    done.push(...(outcome.result.reversal?.writes ?? []));
    if (location.live) {
      await deps.documentSync.refreshDocumentProjection({ documentId, threadId: ctx.threadId });
    }
  }

  if (direction === "redo") {
    const failed = await underGrants(deps, direction, input.path, grants, applyChanges);
    if (failed) return failed;
  }

  // A copy in a draft stays: deleting it is a draft change, which comes later.
  let discarded = false;
  const live = grants.every((grant) => grant.destination.kind === "live");
  const copyWrite =
    direction === "undo" && outcome && !isToolError(outcome) && location.live && live
      ? undidTheCopy(history, outcome.result.reversal?.writes ?? [])
      : null;
  if (copyWrite !== null && (await isEmptyDocument(port, location.uri))) {
    const deleted = await underGrants(deps, direction, input.path, grants, () =>
      port.delete(location.uri, { expected: { kind: "file", documentId } }),
    );
    if (!isToolError(deleted) && deleted.ok) {
      await deps.namespaceChanges.recordDiscardedCopy({
        documentId,
        threadId: ctx.threadId,
        wId: copyWrite,
        fromUri: location.uri,
      });
      location = { live: false, uri: location.uri };
      discarded = true;
    }
  }

  const writes = [...new Set(done)].sort(
    (left, right) => Number(left.slice(1)) - Number(right.slice(1)),
  );
  const fact = namespaceFact(start, location);
  const path = location.uri === start.uri ? input.path : location.uri;
  const payload = {
    path,
    reversal: { direction, writes },
    ...(fact ? { namespace: fact } : {}),
  };
  if (outcome && !isToolError(outcome) && address) {
    // The engine's note that an undone copy is empty no longer holds once the copy is gone.
    const { message: _message, ...base } = outcome.result;
    const result = { ...(discarded ? base : outcome.result), ...payload };
    return {
      output: result,
      ...(location.live ? { metadata: documentRevisionMetadata(address, outcome.revision) } : {}),
    };
  }
  return {
    output: modelResult({ command: direction, status: "reversed", payload }),
  };
}

/** A reversal with no move, delete or copy to account for: the engine's result as it is. */
async function finishContent(
  deps: ToolWiringDeps,
  ctx: ToolHandlerContext,
  address: ResolvedDocumentAddress,
  outcome: ContentOutcome,
) {
  if (isToolError(outcome)) return outcome;
  await deps.documentSync.refreshDocumentProjection({
    documentId: address.documentId,
    threadId: ctx.threadId,
  });
  return {
    output: outcome.result,
    metadata: documentRevisionMetadata(address, outcome.revision),
  };
}
