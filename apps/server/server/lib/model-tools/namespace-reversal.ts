/**
 * `write`'s `undo` and `redo` across both kinds of write handle (D66). A
 * document's creates, moves and deletes go back, or again, through the
 * collab domain's namespace step on the thread's live tree, so links follow
 * a move back (#694), an undone delete is restored and an undone create is
 * deleted; its content writes go to the engine as the exact handles the walk
 * chose. A document with none of them runs as before.
 */
import type {
  AgentEditResultV1,
  WriteOutcome,
  WriteToolInput,
} from "@meridian/agent-edit/integration";
import {
  commandSelection,
  modelResult,
  splitDocumentFile,
  writeHandle,
} from "@meridian/agent-edit/integration";
import {
  type ChangeClaimed,
  executeNamespaceReversal,
  liveAfter,
  locationAfter,
  type NamespaceChangeRecord,
  planReversalWalk,
  type ReversalLocation,
} from "../../domains/collab/index.js";
import type { ContextError } from "../../domains/context/ports/context-port.js";
import type { FileGrant } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { Err, Ok } from "../../shared/result.js";
import { namespaceTree } from "../namespace-tree.js";
import { documentGrant, withDraftWork } from "./file-access.js";
import { containerGrant, underGrants } from "./namespace-commands.js";
import { namespaceContextRefusal, namespaceRefusal } from "./namespace-refusal.js";
import {
  documentRevisionMetadata,
  isToolError,
  type ResolvedDocumentAddress,
  recordTouchInBackground,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
  writeToolError,
} from "./tool-context.js";

type ReversalInput = Extract<WriteToolInput, { command: "undo" | "redo" }>;
type Direction = ReversalInput["command"];
type ContentOutcome = (WriteOutcome & { isError: false }) | WriteToolErrorOutput;

/** The engine's half: where a path is, and an undo or redo of the document's content writes. */
interface ContentReversal {
  resolve(path: string): Promise<ResolvedDocumentAddress | WriteToolErrorOutput>;
  /** Exactly `handles`, or the model's own selector when omitted. */
  run(address: ResolvedDocumentAddress, handles?: readonly string[]): Promise<ContentOutcome>;
}

/** Where the document is as the walk goes: live at `uri`, or deleted from it. */
type Location = ReversalLocation;

function changeRefusal(
  direction: Direction,
  change: NamespaceChangeRecord,
  error: ContextError | ChangeClaimed,
) {
  const path = locationAfter(change, direction);
  if (error.code === "claimed") return namespaceRefusal(direction, path, "already_reversed");
  if (error.code === "not_found")
    return namespaceRefusal(
      direction,
      path,
      change.kind !== "move" && liveAfter(change, direction) ? "folder_missing" : "stale_location",
    );
  return namespaceContextRefusal(direction, { ...error, uri: path });
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

export async function runReversal(
  deps: ToolWiringDeps,
  call: ToolCall,
  input: ReversalInput,
  ctx: ToolHandlerContext,
  content: ContentReversal,
) {
  const direction = input.command;
  const changes = deps.documentSync.namespaceChanges;
  const resolved = await content.resolve(input.path);
  let documentId: string;
  let start: Location;
  if (isToolError(resolved)) {
    // A deleted document has no path to resolve; this thread's delete or undone create names it.
    if (resolved.output.status !== "document_not_found") return resolved;
    const deleted = await changes.findDeletedAt(
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

  if (!isToolError(resolved) && !(await changes.hasHistory(documentId, ctx.threadId))) {
    return finishContent(deps, ctx, resolved, await content.run(resolved));
  }
  const history = await changes.history(documentId, ctx.threadId);
  const walk = planReversalWalk({
    direction,
    selection: commandSelection(input),
    history,
    live: start.live,
  });
  if (!walk.ok)
    return writeToolError(
      direction,
      reversalRefusalMessage(direction, input.path, walk),
      walk.status,
      { path: input.path },
    );
  if (!walk.steps.some((step) => step.kind === "namespace")) {
    if (isToolError(resolved)) {
      return {
        output: modelResult({
          command: direction,
          status: direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
          payload: { path: input.path },
        }),
      };
    }
    // Nothing selected runs the model's own selector, so the engine says why.
    const handles = walk.steps.flatMap((step) => (step.kind === "content" ? step.handles : []));
    const outcome = await content.run(resolved, handles.length > 0 ? handles : undefined);
    return finishContent(deps, ctx, resolved, outcome);
  }

  // A recorded change is reversed where it landed (D66), whatever the thread's mode is now.
  if (walk.steps.some((step) => step.kind === "namespace" && step.change.draftBranchId !== null)) {
    return writeToolError(
      direction,
      `${direction === "undo" ? "Undoing" : "Redoing"} a create, move or delete made in a draft isn't supported yet, so nothing changed.`,
    );
  }
  const live = withDraftWork(call.principal, null);
  // Edit on every folder a change puts the document in, checked before any step runs.
  const folders = new Map<string, FileGrant<"edit"> | null>();
  for (const step of walk.steps) {
    if (step.kind !== "namespace" || !liveAfter(step.change, direction)) continue;
    const uri = locationAfter(step.change, direction);
    if (folders.has(uri)) continue;
    const grant = await containerGrant(deps, call, direction, uri, live);
    if (isToolError(grant)) return grant;
    folders.set(uri, grant);
  }
  /** Edit on the document wherever it is now, and on the folder the change puts it in. */
  const stepGrants = async (
    change: NamespaceChangeRecord,
    at: Location,
  ): Promise<FileGrant<"edit">[] | WriteToolErrorOutput> => {
    const grants: FileGrant<"edit">[] = [];
    if (at.live) {
      const grant = await documentGrant(
        deps,
        live,
        direction,
        { documentId, filePath: at.uri },
        "edit",
      );
      if (isToolError(grant)) return grant;
      grants.push(grant);
    }
    const folder = liveAfter(change, direction)
      ? folders.get(locationAfter(change, direction))
      : null;
    if (folder) grants.push(folder);
    return grants;
  };

  const result = await executeNamespaceReversal<
    { outcome: WriteOutcome & { isError: false }; address: ResolvedDocumentAddress },
    ContextError | WriteToolErrorOutput
  >(
    {
      changes,
      tree: namespaceTree(call.context.livePort()),
      async access(change, at, apply) {
        const grants = await stepGrants(change, at);
        if (isToolError(grants)) return Err(grants);
        const applied = await underGrants(deps, direction, input.path, grants, apply);
        return isToolError(applied) ? Err(applied) : applied;
      },
      async content(uri, handles) {
        const address = await content.resolve(uri);
        if (isToolError(address)) return Err(address);
        const outcome = await content.run(address, handles);
        if (isToolError(outcome)) return Err(outcome);
        return Ok({ value: { outcome, address }, writes: outcome.result.reversal?.writes ?? [] });
      },
    },
    { direction, start, steps: walk.steps },
  );
  const { location, last, writes: done, failure } = result;
  if (failure) {
    const error = isToolError(failure.error)
      ? failure.error
      : failure.kind === "namespace"
        ? changeRefusal(direction, failure.change, failure.error)
        : namespaceContextRefusal(direction, { ...failure.error, uri: location.uri });
    return withNote(
      error,
      done.length === 0 ? "" : `${direction === "undo" ? "Undone" : "Redone"}: ${done.join(", ")}.`,
    );
  }

  if (location.live && last) {
    await deps.documentSync.refreshDocumentProjection({ documentId, threadId: ctx.threadId });
  }
  recordTouchInBackground(deps, documentId, ctx);
  const writes = [...new Set(done)].sort(
    (left, right) => Number(left.slice(1)) - Number(right.slice(1)),
  );
  const fact = namespaceFact(start, location);
  const payload = {
    path: location.uri === start.uri ? input.path : location.uri,
    reversal: { direction, writes },
    ...(fact ? { namespace: fact } : {}),
  };
  if (location.live && last) {
    return {
      output: { ...last.outcome.result, ...payload },
      metadata: documentRevisionMetadata(last.address, last.outcome.revision),
    };
  }
  return { output: modelResult({ command: direction, status: "reversed", payload }) };
}

/** A reversal of content writes alone: the engine's result as it is. */
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
  recordTouchInBackground(deps, address.documentId, ctx);
  return { output: outcome.result, metadata: documentRevisionMetadata(address, outcome.revision) };
}

/** Model-facing explanations stay at the tool boundary; the domain returns dependency facts. */
function reversalRefusalMessage(
  direction: Direction,
  path: string,
  refusal: Exclude<ReturnType<typeof planReversalWalk>, { ok: true }>,
): string {
  if ("message" in refusal) return refusal.message;
  if ("deletedBy" in refusal) {
    const remover = refusal.deletedBy;
    const first = !remover
      ? "Undo the delete first."
      : `${remover.kind === "delete" ? "Undo" : "Redo"} ${writeHandle(remover.wId)} first.`;
    return `${path} is deleted, so its other writes can't be ${direction === "undo" ? "undone" : "redone"}. ${first}`;
  }
  const list = (ids: readonly number[]) =>
    [...new Set(ids)]
      .sort((a, b) => a - b)
      .map(writeHandle)
      .join(", ");
  if (refusal.undoFirst.length > 0) {
    const redoFirst = refusal.blocking.filter((id) => !refusal.undoFirst.includes(id));
    return `Can't redo ${list(refusal.selected)} on its own. Undo ${list(refusal.undoFirst)} first${redoFirst.length ? `, and redo ${list(redoFirst)}` : ""}; those writes changed its location.`;
  }
  const all = [...refusal.selected, ...refusal.blocking];
  const range = `${writeHandle(Math.min(...all))}..${writeHandle(Math.max(...all))}`;
  return direction === "undo"
    ? `Can't undo ${list(refusal.selected)} on its own — ${list(refusal.blocking)} changed the document after it. Undo ${list(refusal.blocking)} first, or undo the range ${range}.`
    : `Can't redo ${list(refusal.selected)} on its own — ${list(refusal.blocking)}, undone too, came before it. Redo ${list(refusal.blocking)} first, or redo the range ${range}.`;
}
