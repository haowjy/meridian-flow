/**
 * The one step every undo and redo of a create, move or delete takes (D66):
 * the model's `undo` and `redo`, reply rollback, the writer's restore and
 * turn undo. The claim, the tree change and the status flip commit together,
 * and a new change is recorded in the transaction that makes it, so a
 * failure leaves neither a half-applied change nor a stale handle.
 */
import { parseWriteHandle } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { Err, Ok, type Result } from "../../../shared/result.js";
import {
  type BranchReversalHistoryReader,
  buildBranchReversalState,
  resolveBranchReversalScope,
} from "./branch-reversal-history.js";
import type {
  AgentNamespaceChangeStore,
  ContentWriteHandle,
  NamespaceChangeOwner,
  NamespaceChangeRecord,
  NamespaceChangeShape,
} from "./ports/agent-namespace-changes.js";

/**
 * The live tree a change acts on, as one thread's live port sees it: a move
 * goes through the mover so links follow (#694), and a delete is soft.
 */
export interface NamespaceTree<E> {
  move(fromUri: string, toUri: string, documentId: string): Promise<Result<unknown, E>>;
  delete(uri: string, documentId: string): Promise<Result<unknown, E>>;
  restore(uri: string, documentId: string): Promise<Result<unknown, E>>;
  /**
   * For several changes in one transaction: flushes link derivations for
   * moves out of `uris` now, before it, and returns the tree with moves that
   * don't flush again, so none waits on a flush while the transaction holds locks.
   */
  settleLinks(uris: readonly string[]): Promise<NamespaceTree<E>>;
  /**
   * Takes the tree's locks for changes at `uris` in the caller's
   * transaction, before it locks any document, to keep the seam's lock order.
   */
  lock(uris: readonly string[]): Promise<Result<unknown, E>>;
}

/** Another undo, redo or restore already moved the change on. */
export type ChangeClaimed = { code: "claimed" };

export type NamespaceChanges = Omit<AgentNamespaceChangeStore, "record" | "transition"> & {
  /** Makes a move or delete through `apply` and records its handle, in one transaction. */
  commit<E>(
    owner: NamespaceChangeOwner,
    apply: () => Promise<Result<Exclude<NamespaceChangeShape, { kind: "create" }>, E>>,
  ): Promise<Result<NamespaceChangeRecord, E>>;
  /** Undoes or redoes one change, in one transaction. */
  reverse<E>(
    tree: NamespaceTree<E>,
    change: NamespaceChangeRecord,
    direction: "undo" | "redo",
  ): Promise<Result<void, E | ChangeClaimed>>;
};

/** Whether the document exists after `change` goes `direction`. */
export function liveAfter(change: NamespaceChangeShape, direction: "undo" | "redo"): boolean {
  if (change.kind === "move") return true;
  return (change.kind === "delete") === (direction === "undo");
}

/** Where the document is after `change` goes `direction`. */
export function locationAfter(change: NamespaceChangeShape, direction: "undo" | "redo"): string {
  return change.kind === "move" && direction === "redo" ? change.toUri : change.fromUri;
}

function applyChange<E>(
  tree: NamespaceTree<E>,
  documentId: string,
  change: NamespaceChangeShape,
  direction: "undo" | "redo",
): Promise<Result<unknown, E>> {
  if (change.kind === "move") {
    return direction === "undo"
      ? tree.move(change.toUri, change.fromUri, documentId)
      : tree.move(change.fromUri, change.toUri, documentId);
  }
  return liveAfter(change, direction)
    ? tree.restore(change.fromUri, documentId)
    : tree.delete(change.fromUri, documentId);
}

/** Carries a refusal out of the transaction so it rolls back. */
class StepRefused<E> extends Error {
  constructor(readonly refusal: E) {
    super("Namespace change refused");
  }
}

async function refusable<T, E>(
  atomic: <R>(operation: () => Promise<R>) => Promise<R>,
  operation: () => Promise<T>,
): Promise<Result<T, E>> {
  try {
    return Ok(await atomic(operation));
  } catch (cause) {
    if (cause instanceof StepRefused) return Err(cause.refusal as E);
    throw cause;
  }
}

/**
 * The thread's content handles in its Work draft, as the engine's undo and
 * redo route them (`thread-peer-reversals`): on the same `w_id` sequence as
 * its live ones.
 */
async function draftedContent(
  reader: BranchReversalHistoryReader,
  documentId: string,
  threadId: string,
  now: Date,
): Promise<ContentWriteHandle[]> {
  const scope = await resolveBranchReversalScope({
    documentId: documentId as DocumentId,
    threadId: threadId as ThreadId,
    ...reader,
  });
  if (!scope) return [];
  const state = buildBranchReversalState(threadId as ThreadId, scope.rows);
  const handles: ContentWriteHandle[] = [];
  for (const write of state.activeWrites) {
    const wId = parseWriteHandle(write.handle);
    if (wId !== undefined) handles.push({ wId, status: "active", reversedAt: null });
  }
  for (const reversal of state.reversals) {
    if (reversal.status !== "reversed" || (reversal.expiresAt && reversal.expiresAt <= now)) {
      continue;
    }
    for (const handle of reversal.writeIds) {
      const wId = parseWriteHandle(handle);
      if (wId !== undefined) {
        handles.push({ wId, status: "reversed", reversedAt: reversal.reversedAt ?? null });
      }
    }
  }
  return handles;
}

export function createNamespaceChanges(deps: {
  store: AgentNamespaceChangeStore;
  /** A transaction, or a savepoint inside the caller's, so a refusal rolls back only this step. */
  atomic<T>(operation: () => Promise<T>): Promise<T>;
  /** The thread's Work-draft journal, so a walk counts drafted content writes too. */
  draftHistory: BranchReversalHistoryReader;
}): NamespaceChanges {
  const { store, atomic } = deps;
  const { record: _record, transition: _transition, ...reads } = store;
  return {
    ...reads,

    async history(documentId, threadId) {
      const [recorded, drafted] = await Promise.all([
        store.history(documentId, threadId),
        draftedContent(deps.draftHistory, documentId, threadId, new Date()),
      ]);
      if (drafted.length === 0) return recorded;
      return {
        namespace: recorded.namespace,
        content: [...recorded.content, ...drafted].sort((left, right) => left.wId - right.wId),
      };
    },

    commit(owner, apply) {
      return refusable(atomic, async () => {
        const applied = await apply();
        if (!applied.ok) throw new StepRefused(applied.error);
        return store.record({ ...owner, ...applied.value });
      });
    },

    async reverse(tree, change, direction) {
      const settled =
        change.kind === "move"
          ? await tree.settleLinks([direction === "undo" ? change.toUri : change.fromUri])
          : tree;
      return refusable(atomic, async () => {
        if (!(await store.transition(change.id, direction === "undo" ? "active" : "reversed"))) {
          throw new StepRefused({ code: "claimed" });
        }
        const applied = await applyChange(settled, change.documentId, change, direction);
        if (!applied.ok) throw new StepRefused(applied.error);
      });
    },
  };
}
