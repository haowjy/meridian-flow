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
  liveAfter,
  locationAfter,
  type NamespaceChangeRecord,
} from "../../domains/collab/index.js";
import type { ContextError } from "../../domains/context/ports/context-port.js";
import type { FileGrant } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import { namespaceTree } from "../namespace-tree.js";
import { documentGrant, withDraftWork } from "./file-access.js";
import { containerGrant, underGrants } from "./namespace-commands.js";
import { namespaceContextRefusal, namespaceRefusal } from "./namespace-refusal.js";
import { planReversalWalk } from "./namespace-reversal-plan.js";
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
export interface ContentReversal {
  resolve(path: string): Promise<ResolvedDocumentAddress | WriteToolErrorOutput>;
  /** Exactly `handles`, or the model's own selector when omitted. */
  run(address: ResolvedDocumentAddress, handles?: readonly string[]): Promise<ContentOutcome>;
}

/** Where the document is as the walk goes: live at `uri`, or deleted from it. */
type Location = { live: boolean; uri: string };

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

  const history = await changes.history(documentId, ctx.threadId);
  if (!isToolError(resolved) && history.namespace.length === 0) {
    return finishContent(deps, ctx, resolved, await content.run(resolved));
  }
  const walk = planReversalWalk({
    direction,
    selection: commandSelection(input),
    history,
    live: start.live,
    path: input.path,
  });
  if (!walk.ok) return writeToolError(direction, walk.message, walk.status, { path: input.path });
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

  const tree = namespaceTree(call.context.livePort());
  let location = start;
  let last: {
    outcome: WriteOutcome & { isError: false };
    address: ResolvedDocumentAddress;
  } | null = null;
  const done: string[] = [];
  const contentDone = new Set<string>();
  const doneNote = () =>
    done.length === 0 ? "" : `${direction === "undo" ? "Undone" : "Redone"}: ${done.join(", ")}.`;

  for (const step of walk.steps) {
    if (step.kind === "namespace") {
      const { change } = step;
      const grants = await stepGrants(change, location);
      if (isToolError(grants)) return withNote(grants, doneNote());
      const applied = await underGrants(deps, direction, input.path, grants, () =>
        changes.reverse(tree, change, direction),
      );
      if (isToolError(applied)) return withNote(applied, doneNote());
      if (!applied.ok) {
        return withNote(changeRefusal(direction, change, applied.error), doneNote());
      }
      done.push(writeHandle(change.wId));
      location = { live: liveAfter(change, direction), uri: locationAfter(change, direction) };
      continue;
    }
    // An earlier step may have reversed these with their group (a writer's turn undo groups a turn's writes).
    const handles = step.handles.filter((handle) => !contentDone.has(handle));
    if (handles.length === 0) continue;
    const address = await content.resolve(location.uri);
    if (isToolError(address)) return withNote(address, doneNote());
    const outcome = await content.run(address, handles);
    if (isToolError(outcome)) return withNote(outcome, doneNote());
    for (const handle of outcome.result.reversal?.writes ?? []) {
      done.push(handle);
      contentDone.add(handle);
    }
    last = { outcome, address };
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
