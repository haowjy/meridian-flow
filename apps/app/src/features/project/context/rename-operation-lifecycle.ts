/** Account-owned transient operation selection, independent of mounted feedback rows. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import {
  type FolderNamespaceRecord,
  folderForId,
  NAMESPACE_RECEIPT_NOTE_TTL_MS,
  type NamespaceIntent,
  namespaceRequestId,
  type ResourceProjectionSnapshot,
  type ResourceRecord,
  resourceForDocumentIdentity,
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
    intent.attempts.some((attempt) => namespaceRequestId(attempt.request) === operationId);
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

function subjectKey(projectId: string, kind: LinkNoteSubject["kind"], handle: string): string {
  return JSON.stringify([projectId, kind, handle]);
}

type Entry = {
  projectId: string;
  kind: LinkNoteSubject["kind"];
  handle: string;
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  /** Whether a snapshot has carried this subject's intents since admission. */
  seen: boolean;
  selection: Selection;
  stop: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Each command owns its watch through pending work and feedback, never through a row mount. */
export class RenameOperationLifecycle {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private closed = false;
  constructor(
    private replica: Pick<
      AccountResourceReplica,
      "observeProjection" | "readKnownDocument" | "readKnownFolder"
    >,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get(projectId: string, subject: LinkNoteSubject): Selection | null {
    for (const entry of this.entries.values()) {
      if (entry.projectId !== projectId || entry.kind !== subject.kind) continue;
      const handle =
        subject.kind === "file"
          ? resourceForDocumentIdentity(entry.records, subject.id)?.resource.handle
          : folderForId(entry.folders, subject.id)?.handle;
      if (handle === entry.handle) return entry.selection;
    }
    return null;
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
  async remember(projectId: string, subject: LinkNoteSubject, operationId: string) {
    if (this.closed) return;
    // A failed lookup only costs the note; the command itself is unaffected.
    const known =
      subject.kind === "file"
        ? await this.replica.readKnownDocument(projectId, subject.id).catch(() => null)
        : null;
    const folder =
      subject.kind === "folder"
        ? await this.replica.readKnownFolder(subject.id).catch(() => null)
        : null;
    const handle = known?.key.handle ?? folder?.handle;
    if (this.closed || !handle) return;
    const key = subjectKey(projectId, subject.kind, handle);
    const old = this.entries.get(key);
    if (old?.selection.operationId === operationId) return;
    if (old) this.retire(key, old);
    const entry: Entry = {
      projectId,
      kind: subject.kind,
      handle,
      records: known ? [known.record] : [],
      folders: folder ? [folder] : [],
      seen: false,
      selection: { operationId, feedback: null },
      stop: () => {},
    };
    this.entries.set(key, entry);
    const update = (snapshot: ResourceProjectionSnapshot) => {
      if (this.entries.get(key) !== entry) return;
      const identity = () =>
        subject.kind === "file"
          ? entry.records.find((record) => record.resource.handle === handle)?.resource.identity
              .documentId
          : entry.folders.find((folder) => folder.handle === handle)?.folderId;
      const previousIdentity = identity();
      // A replay from before admission cannot erase the known identity either.
      if (
        subject.kind === "file" &&
        snapshot.records.some((record) => record.resource.handle === handle)
      )
        entry.records = snapshot.records;
      if (subject.kind === "folder" && snapshot.folders.some((folder) => folder.handle === handle))
        entry.folders = snapshot.folders;
      if (previousIdentity !== identity()) this.notify();
      const file =
        subject.kind === "file"
          ? snapshot.records.find((record) => record.resource.handle === handle)
          : null;
      const intents =
        subject.kind === "folder"
          ? snapshot.folders.find((folder) => folder.handle === handle)?.intents
          : file?.intents;
      // Absent before it was ever seen is a replay from before admission; absent after
      // being seen means the subject is gone (a deleted folder), so its watch ends.
      if (!intents) {
        if (entry.seen) this.retire(key, entry);
        return;
      }
      entry.seen = true;
      const state =
        file?.resource.lifecycle.kind === "terminal"
          ? { kind: "retired" as const }
          : operationLifecycle(intents, operationId, Date.now());
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
