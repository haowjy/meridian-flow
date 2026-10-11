/** Account-owned transient operation selection, independent of mounted feedback rows. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import {
  NAMESPACE_RECEIPT_NOTE_TTL_MS,
  type NamespaceIntent,
  type ResourceProjectionSnapshot,
} from "@meridian/resource-replica";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";

export type LinkNoteSubject = { kind: "file" | "folder"; id: string };
export type OperationFeedback = { receipt: ContextOperationReceipt; deadline: number };
type Selection = { operationId: string; feedback: OperationFeedback | null };
type Lifecycle =
  | { kind: "pending" }
  | { kind: "retired" }
  | { kind: "feedback"; feedback: OperationFeedback };

/** Rebased successors retain the operation id; sequence, not array position, selects authority. */
export function operationLifecycle(
  intents: readonly NamespaceIntent[],
  operationId: string,
  now: number,
): Lifecycle {
  const matches = (intent: NamespaceIntent) =>
    intent.operationId === operationId ||
    intent.attempts.some(
      (attempt) =>
        attempt.request.kind !== "create" && attempt.request.body.operationId === operationId,
    );
  const intent = intents
    .filter(matches)
    .reduce<NamespaceIntent | null>(
      (current, next) => (!current || next.sequence > current.sequence ? next : current),
      null,
    );
  // A cached projection can precede admission; absence is not terminal evidence.
  if (!intent) return { kind: "pending" };
  if (
    ["cancelled", "superseded", "needs-repair", "settled-locally"].includes(intent.state) ||
    intent.desired.kind === "delete"
  )
    return { kind: "retired" };
  if (intent.settledAt === undefined) return { kind: "pending" };
  const deadline = intent.settledAt + NAMESPACE_RECEIPT_NOTE_TTL_MS;
  const receipt = [...intent.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.outcome?.kind === "operation" &&
        attempt.outcome.receipt.operationId === operationId,
    )?.outcome;
  if (
    now >= deadline ||
    receipt?.kind !== "operation" ||
    receipt.receipt.command.kind !== "move" ||
    !receipt.receipt.result.ok
  )
    return { kind: "retired" };
  return { kind: "feedback", feedback: { receipt: receipt.receipt, deadline } };
}

function subjectKey(projectId: string, subject: LinkNoteSubject): string {
  return JSON.stringify([projectId, subject.kind, subject.id]);
}

type Entry = { selection: Selection; stop: () => void; timer?: ReturnType<typeof setTimeout> };

/** Each command owns its watch through pending work and feedback, never through a row mount. */
export class RenameOperationLifecycle {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private closed = false;
  constructor(private replica: Pick<AccountResourceReplica, "observeProjection">) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get(projectId: string, subject: LinkNoteSubject): Selection | null {
    return this.entries.get(subjectKey(projectId, subject))?.selection ?? null;
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  private retire(key: string, entry: Entry) {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    entry.stop();
    clearTimeout(entry.timer);
    this.notify();
  }
  remember(projectId: string, subject: LinkNoteSubject, operationId: string) {
    if (this.closed) return;
    const key = subjectKey(projectId, subject);
    const old = this.entries.get(key);
    if (old?.selection.operationId === operationId) return;
    if (old) this.retire(key, old);
    const entry: Entry = { selection: { operationId, feedback: null }, stop: () => {} };
    this.entries.set(key, entry);
    const update = (snapshot: ResourceProjectionSnapshot) => {
      if (this.entries.get(key) !== entry) return;
      const file =
        subject.kind === "file"
          ? snapshot.records.find((record) => record.resource.identity.documentId === subject.id)
          : null;
      const intents =
        subject.kind === "folder"
          ? snapshot.folders.find((folder) => folder.folderId === subject.id)?.intents
          : file?.intents;
      const state =
        !intents || file?.resource.lifecycle.kind === "terminal"
          ? { kind: "retired" as const }
          : operationLifecycle(intents ?? [], operationId, Date.now());
      if (state.kind === "retired") this.retire(key, entry);
      else if (state.kind === "pending") {
        if (!entry.selection.feedback) return;
        clearTimeout(entry.timer);
        entry.selection = { operationId, feedback: null };
        this.notify();
      } else if (state.kind === "feedback") {
        if (entry.selection.feedback?.deadline === state.feedback.deadline) return;
        clearTimeout(entry.timer);
        entry.selection = { operationId, feedback: state.feedback };
        entry.timer = setTimeout(
          () => this.retire(key, entry),
          state.feedback.deadline - Date.now(),
        );
        this.notify();
      }
    };
    const unsubscribe = this.replica.observeProjection(projectId, update, () => undefined);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    };
    entry.stop = stop;
    // Observation ports may deliver their current snapshot synchronously.
    if (this.entries.get(key) !== entry) stop();
    this.notify();
  }
  dispose() {
    this.closed = true;
    for (const [key, entry] of this.entries) this.retire(key, entry);
    this.listeners.clear();
  }
}

const lifecycles = new WeakMap<AccountResourceReplica, RenameOperationLifecycle>();
export function renameOperationLifecycle(
  replica: AccountResourceReplica,
): RenameOperationLifecycle {
  let lifecycle = lifecycles.get(replica);
  if (!lifecycle) {
    lifecycle = new RenameOperationLifecycle(replica);
    lifecycles.set(replica, lifecycle);
  }
  return lifecycle;
}
