/**
 * Account-lifetime command ownership. Each review item owns one frozen FIFO for its text, tree
 * and text+tree clicks; each draft room is a resource the item attaches, with its optimistic base.
 */
import {
  APPLY_RECORD_ROOT,
  applyBase,
  applySpanPatches,
  baseViewDelta,
  blocksEqual,
  composeGroups,
  readApplyRecord,
} from "@meridian/agent-edit/diff";
import { parseDraftItemKey } from "@meridian/contracts";
import type {
  ApplyClick,
  DraftMetadataResponse,
  ThreadDraftListItem,
} from "@meridian/contracts/branches";
import { draftRoomName, parseYjsRoomName } from "@meridian/contracts/protocol";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  applyDraftClick,
  discardCreatedDraft,
  discardWorkDrafts,
  observeDraftClick,
} from "@/client/api/branches-api";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  type DraftRoomRead,
  type DraftRoomRegistry,
  readDraftRoom,
} from "@/core/editor/draft-room-read";
import { type ApplyClickOutcome, ApplyClickQueue, type FrozenApply } from "./apply-click-queue";
import { startDraftDiscardSession } from "./draft-discard-session";
import type { BranchCommandFailure, DraftRef } from "./review-command-types";
import { readBase } from "./review-frame";
import type { ChangeTarget, ReviewChange, TextTarget } from "./review-model";
import { type ReviewRuntime, retainReviewRuntime } from "./review-runtime";

export type DraftCommandState = {
  applying: boolean;
  stalled: boolean;
  pending: boolean;
  hidden: boolean;
  discarding: ((change: ReviewChange) => boolean) | null;
  failure: BranchCommandFailure | null;
  closed: boolean;
  checkingClose: boolean;
  removed: boolean;
  unsentText: string | null;
  liveUri: string | null;
};
const EMPTY: DraftCommandState = {
  applying: false,
  stalled: false,
  pending: false,
  hidden: false,
  discarding: null,
  failure: null,
  closed: false,
  checkingClose: false,
  removed: false,
  unsentText: null,
  liveUri: null,
};
export type CommandOutcome =
  | { kind: "blocked" }
  | {
      kind: "done";
      /** The document had been deleted from the manuscript and this Apply brought it back. */
      restored?: true;
      /** Per-item facts committed by this click. */
      applied?: {
        itemKey: string;
        transition?: { from: string | null; to: string | null };
        renamed?: string;
      }[];
    }
  /** The document was deleted and the click didn't say the writer knew: nothing changed. */
  | { kind: "needs-restore" }
  | { kind: "change-refused"; code: string };
type Binding = {
  session: DocumentSession;
  runtime: ReviewRuntime;
  notices: Set<() => void>;
  stop(): void;
};
/** A review item's command schedule: one FIFO, whatever each click carries. */
type Item = {
  ref: DraftRef;
  queue: ApplyClickQueue;
  /** Its draft rooms: a text click pins the draft it froze, so an older room can outlive a newer bind. */
  rooms: Set<Entry>;
};
/** One draft generation's room, attached to its item. */
type Entry = {
  ref: DraftRef;
  draftId: string;
  roomKey: string;
  item: Item;
  binding: Binding | null;
  users: number;
  lease: DraftRoomRead | null;
  unwatchLease(): void;
};
export type CapturedApply = {
  /** Releases the already-queued click to send. A preceding click may have settled its tree cut. */
  release(options?: { omitTree?: boolean; cancel?: boolean }): {
    sent: boolean;
    outcome: Promise<CommandOutcome>;
  };
};
export type DiscardNotice = {
  itemKey?: string;
  kind: "discarded" | "removed";
  undo?: () => Promise<void>;
  end(): void;
};
/**
 * A refusal the screen already explains reverts silently (offer only what
 * applies): an archived Work removes its commands and shows its own notice with
 * Unarchive, so a held "archived" line would only go stale once it is unarchived.
 */
function shownRefusal(failure: BranchCommandFailure): BranchCommandFailure | null {
  return failure.serverCode === "work_archived" ? null : failure;
}
/** The server's word for an unapplied click, as the surfaces' refusal copy keys it. */
function refusalCode(answer: Exclude<ApplyClickOutcome, { status: "applied" }>): string {
  switch (answer.status) {
    case "refused":
      return answer.reason;
    case "needs_restore":
    case "changed":
      return answer.status;
    default:
      return "gone";
  }
}
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

function sendBarrier() {
  let release!: (value: { omitTree?: boolean; cancel?: boolean }) => void;
  const promise = new Promise<{ omitTree?: boolean; cancel?: boolean }>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export class DraftCommandOwner {
  private readonly items = new Map<string, Item>();
  private readonly entries = new Map<string, Entry>();
  private readonly byItem = new Map<string, Entry>();
  private readonly identities = new Map<string, string>();
  private readonly records = new Map<string, DraftCommandState>();
  private readonly listeners = new Set<() => void>();
  private readonly closingWorks = new Set<string>();
  private readonly resolvingGone = new Map<string, Promise<void>>();
  private readonly reconciling = new Map<string, Promise<boolean>>();
  /** Documents an Apply brought back from a delete, until dismissed or another document shows. */
  private readonly restoredDocuments = new Set<string>();
  /** Final paths allocated by Apply, until dismissed or another document shows. */
  private readonly renamedDocuments = new Map<string, string>();
  private active = true;
  private revision = 0;
  constructor(
    private readonly registry: DraftRoomRegistry & {
      closeDraftRoom(roomKey: string): Promise<void>;
    },
    private readonly lifecycle: {
      resolveGone?(
        ref: DraftRef,
      ): Promise<{ disposition: "closed" | "removed"; liveUri?: string } | null>;
      removed?(ref: DraftRef): void;
      closeCreated?(ref: DraftRef): void;
      markOwnRemoval?(ref: DraftRef): (outcome: "removed" | "kept") => void;
    } = {},
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  /**
   * State follows the item's current draft generation. An item key (branch + document) outlives
   * its drafts: discarding one item keeps the branch, and a later write mints a new draft under
   * the same key. Each generation's record stays its own; only `bind` and `reconcileClosed`
   * move the key to a newer one.
   */
  state(itemKey: string): DraftCommandState {
    return this.records.get(this.generation(itemKey)) ?? EMPTY;
  }
  /** The draft the item's state currently follows; the key itself before any draft is known. */
  generation(itemKey: string): string {
    return this.identities.get(itemKey) ?? itemKey;
  }
  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private setState(
    itemKey: string,
    state: Partial<DraftCommandState>,
    id = this.identities.get(itemKey) ?? itemKey,
  ) {
    const previous = this.records.get(id) ?? EMPTY;
    if (
      Object.entries(state).every(
        ([key, value]) => previous[key as keyof DraftCommandState] === value,
      )
    )
      return;
    this.records.set(id, { ...previous, ...state });
    this.publish();
  }

  bind(ref: DraftRef, session: DocumentSession): () => void {
    const address = parseYjsRoomName(session.roomKey);
    if (address?.kind !== "draft") throw new Error("Commands require a draft room");
    const item = this.item(ref);
    const previousId = this.identities.get(ref.itemKey);
    this.identities.set(ref.itemKey, address.draftId);
    if (previousId !== address.draftId) {
      this.publish();
      this.publishQueue(item);
    }
    let entry = this.entries.get(address.draftId);
    if (!entry) {
      entry = {
        ref,
        draftId: address.draftId,
        roomKey: session.roomKey,
        item,
        binding: null,
        users: 0,
        lease: null,
        unwatchLease: () => {},
      };
      this.entries.set(address.draftId, entry);
      this.byItem.set(ref.itemKey, entry);
      item.rooms.add(entry);
    }
    const held = entry;
    held.users++;
    this.attach(held, session);
    return () => {
      held.users--;
      this.releaseIdle(held);
    };
  }

  private item(ref: DraftRef): Item {
    const known = this.items.get(ref.itemKey);
    if (known) return known;
    const item: Item = {
      ref,
      rooms: new Set(),
      queue: new ApplyClickQueue({
        send: (body) => applyDraftClick(ref, body),
        lookup: (body) => observeDraftClick(ref, body),
        changed: () => {
          for (const entry of item.rooms) {
            entry.binding?.runtime.invalidateBase();
            this.holdRoom(entry);
          }
          this.publishQueue(item);
          this.releaseItem(item);
        },
      }),
    };
    this.items.set(ref.itemKey, item);
    return item;
  }

  /** The item's schedule, on the generation its state follows: the one publication path. */
  private publishQueue({ ref, queue }: Item) {
    this.setState(ref.itemKey, {
      pending: queue.clicks.length > 0,
      applying: queue.applying,
      stalled: queue.clicks[0]?.stalled ?? false,
    });
  }

  /** The clicks a draft's room records and its optimistic base folds, in FIFO order. */
  private textClicks(entry: Entry) {
    return entry.item.queue.clicks.filter((click) => click.body.draftId === entry.draftId);
  }

  /** A draft with clicks outstanding keeps its room read, surface or not, to observe their record. */
  private holdRoom(entry: Entry) {
    const pending = this.textClicks(entry).length > 0;
    if (pending && !entry.lease) {
      const lease = readDraftRoom(this.registry, entry.roomKey);
      entry.lease = lease;
      const follow = () => {
        const next = lease.usable();
        if (next) this.attach(entry, next);
      };
      entry.unwatchLease = lease.subscribe(follow);
      follow();
    }
    if (!pending && entry.lease) {
      entry.unwatchLease();
      entry.lease.dispose();
      entry.lease = null;
    }
    this.releaseIdle(entry);
  }

  private detach(entry: Entry) {
    const binding = entry.binding;
    if (!binding) return;
    entry.binding = null;
    binding.stop();
  }

  private attach(entry: Entry, session: DocumentSession) {
    if (entry.binding?.session === session) return;
    this.detach(entry);
    const hold = retainReviewRuntime(session);
    const binding: Binding = {
      session,
      runtime: hold.runtime,
      notices: new Set(),
      stop: () => {},
    };
    entry.binding = binding;
    binding.runtime.setBaseProvider((_room, schema) => {
      const recorded = new Set(readApplyRecord(session.document).map((row) => row.commandId));
      let base: readonly PMNode[] = readBase(session.document, schema);
      for (const click of this.textClicks(entry))
        if (!recorded.has(click.body.commandId))
          base = applyBase(schema, base, click.optimistic, click.patched);
      return base;
    });
    const record = session.document.getArray(APPLY_RECORD_ROOT);
    const observe = () => {
      binding.runtime.invalidateBase();
      entry.item.queue.observe(
        entry.draftId,
        readApplyRecord(session.document).flatMap((row) => (row.commandId ? [row.commandId] : [])),
      );
    };
    record.observeDeep(observe);
    let stopSession = () => {};
    binding.stop = () => {
      stopSession();
      for (const end of binding.notices) end();
      record.unobserveDeep(observe);
      binding.runtime.setBaseProvider((room, schema) => readBase(room.document, schema));
      hold.release();
    };
    stopSession = session.subscribe((snapshot) => {
      if (entry.binding !== binding) return;
      const connection = snapshot.connectionState;
      if (
        connection?.kind === "reset" &&
        (connection.disposition === "closed" || connection.disposition === "removed")
      ) {
        this.finishClose(entry.ref, entry.draftId, connection.disposition);
      } else if (
        snapshot.status === "destroyed" ||
        connection?.kind === "reset" ||
        connection?.kind === "terminal" ||
        connection?.kind === "unauthorized"
      ) {
        this.detach(entry);
        entry.item.queue.refuseUnsent(entry.draftId);
      }
    });
    // subscribe publishes synchronously, including an already retired session.
    if (entry.binding !== binding) stopSession();
    else observe();
  }

  /** Whether an Apply brought this document back from a delete (D79). */
  wasRestored(projectId: string, documentId: string): boolean {
    return this.restoredDocuments.has(JSON.stringify([projectId, documentId]));
  }

  renamedPath(projectId: string, documentId: string): string | null {
    return this.renamedDocuments.get(JSON.stringify([projectId, documentId])) ?? null;
  }

  forgetApplyFacts(projectId: string, documentId: string): void {
    const key = JSON.stringify([projectId, documentId]);
    const restored = this.restoredDocuments.delete(key);
    const renamed = this.renamedDocuments.delete(key);
    if (restored || renamed) this.publish();
  }

  /** The writer moved on to `documentId`: every other document's Apply fact ends. */
  keepApplyFactsOnly(projectId: string, documentId: string): void {
    const kept = JSON.stringify([projectId, documentId]);
    let changed = false;
    for (const key of this.restoredDocuments)
      if (key !== kept) changed = this.restoredDocuments.delete(key) || changed;
    for (const key of this.renamedDocuments.keys())
      if (key !== kept) changed = this.renamedDocuments.delete(key) || changed;
    if (changed) this.publish();
  }

  /**
   * The drafts of one document that a surface holds open right now. A live delete leaves
   * them active (D79), so their tabs stay; the review list lags, this does not.
   */
  boundDrafts(projectId: string, documentId: string): DraftRef[] {
    return [...this.entries.values()].flatMap(({ ref, draftId, binding }) =>
      binding &&
      ref.projectId === projectId &&
      ref.documentId === documentId &&
      !this.records.get(draftId)?.closed
        ? [ref]
        : [],
    );
  }

  /**
   * Only the typed metadata `gone` answer enters here, never a failed read or list omission.
   * It retires the generation known when it arrives: a draft bound while the answer resolves
   * is a newer one, and stays open.
   */
  metadataGone(ref: DraftRef): Promise<void> {
    const id = this.generation(ref.itemKey);
    if (!this.active || this.records.get(id)?.closed) return Promise.resolve();
    const pending = this.resolvingGone.get(id);
    if (pending) return pending;
    const entry = this.entries.get(id);
    const lease = entry?.binding
      ? readDraftRoom(this.registry, entry.binding.session.roomKey)
      : null;
    if (entry) entry.users++;
    this.setState(ref.itemKey, { checkingClose: true }, id);
    const resolving = (async () => {
      const disposition = await this.lifecycle.resolveGone?.(ref);
      if (this.active && disposition)
        this.finishClose(ref, id, disposition.disposition, disposition.liveUri);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.resolvingGone.delete(id);
        if (this.active) this.setState(ref.itemKey, { checkingClose: false }, id);
        lease?.dispose();
        if (entry) {
          entry.users--;
          this.releaseIdle(entry);
        }
      });
    this.resolvingGone.set(id, resolving);
    return resolving;
  }

  /**
   * Whether the item is open after asking the server, for an item whose known generation is
   * closed. A different active draft is a replacement under the same key: the item follows it.
   * The closed generation's record (its unsent text, its queue) is kept, and a failed read
   * leaves the item closed.
   */
  reconcileClosed(ref: DraftRef, read: () => Promise<DraftMetadataResponse>): Promise<boolean> {
    if (!this.state(ref.itemKey).closed) return Promise.resolve(this.active);
    const pending = this.reconciling.get(ref.itemKey);
    if (pending) return pending;
    const closedId = this.generation(ref.itemKey);
    const reconcile = read()
      .then((answer) => {
        if (!this.active || answer.status !== "active" || answer.draftId === closedId) return false;
        if (this.generation(ref.itemKey) === closedId) {
          this.identities.set(ref.itemKey, answer.draftId);
          this.publish();
          const item = this.items.get(ref.itemKey);
          if (item) this.publishQueue(item);
        }
        return !this.state(ref.itemKey).closed;
      })
      .catch(() => false)
      .finally(() => this.reconciling.delete(ref.itemKey));
    this.reconciling.set(ref.itemKey, reconcile);
    return reconcile;
  }

  private finishClose(
    ref: DraftRef,
    id: string,
    disposition: "closed" | "removed",
    liveUri?: string,
  ) {
    const record = this.records.get(id) ?? EMPTY;
    if (!this.active || record.closed) return;
    const entry = this.entries.get(id);
    const frame = entry?.binding?.runtime.projectNow();
    const unsentText =
      disposition === "closed" && !record.hidden && entry?.binding?.session.hasUnacknowledgedEdits()
        ? (frame?.doc.textBetween(0, frame.doc.content.size, "\n\n") ?? null)
        : null;
    if (disposition === "removed") this.lifecycle.removed?.(ref);
    this.setState(
      ref.itemKey,
      {
        closed: true,
        checkingClose: false,
        removed: disposition === "removed",
        unsentText,
        liveUri: liveUri ?? null,
      },
      id,
    );
    if (entry?.binding) for (const end of entry.binding.notices) end();
    // Only this draft's clicks: the item's tree clicks and a newer draft's go on.
    this.items.get(ref.itemKey)?.queue.close(id);
    if (id !== ref.itemKey)
      void this.registry.closeDraftRoom(draftRoomName(id)).catch(() => undefined);
  }

  private releaseIdle(entry: Entry) {
    if (entry.users || this.textClicks(entry).length || this.entries.get(entry.draftId) !== entry)
      return;
    this.detach(entry);
    this.entries.delete(entry.draftId);
    entry.item.rooms.delete(entry);
    if (this.byItem.get(entry.ref.itemKey) === entry) this.byItem.delete(entry.ref.itemKey);
    this.releaseItem(entry.item);
  }

  private releaseItem(item: Item) {
    if (item.rooms.size || item.queue.clicks.length || this.items.get(item.ref.itemKey) !== item)
      return;
    this.items.delete(item.ref.itemKey);
  }

  /** A click's answer, as its caller's outcome and a refusal on the generation it was made for. */
  private settled(ref: DraftRef, id: string, answer: ApplyClickOutcome): CommandOutcome {
    if (answer.status !== "applied" && answer.status !== "landed" && answer.status !== "cancelled")
      this.setState(
        ref.itemKey,
        { failure: shownRefusal({ code: "apply-refused", serverCode: refusalCode(answer) }) },
        id,
      );
    return this.outcomeOf(ref, answer);
  }

  private outcomeOf(ref: DraftRef, answer: ApplyClickOutcome): CommandOutcome {
    if (answer.status === "applied") {
      if (answer.restored) {
        this.restoredDocuments.add(JSON.stringify([ref.projectId, ref.documentId]));
      }
      for (const item of answer.applied) {
        if (!item.renamed) continue;
        const documentId = parseDraftItemKey(item.itemKey)?.documentId;
        if (documentId)
          this.renamedDocuments.set(JSON.stringify([ref.projectId, documentId]), item.renamed.path);
      }
      if (answer.restored || answer.applied.some((item) => item.renamed)) this.publish();
      return {
        kind: "done",
        ...(answer.restored ? { restored: true as const } : {}),
        applied: answer.applied.map((item) => ({
          itemKey: item.itemKey,
          ...(item.transition ? { transition: item.transition } : {}),
          ...(item.renamed ? { renamed: item.renamed.path } : {}),
        })),
      };
    }
    if (answer.status === "landed") return { kind: "done" };
    if (answer.status === "cancelled") return { kind: "blocked" };
    if (answer.status === "needs_restore") return { kind: "needs-restore" };
    return { kind: "change-refused", code: refusalCode(answer) };
  }

  /**
   * No await before snapshot, group validation, O, P and acknowledgement barrier are frozen.
   * `restore` says the writer saw the document deleted from the manuscript and chose to bring
   * it back; without it, a deleted document answers `needs-restore` and nothing changes.
   * Every click joins the item's one FIFO, so a tree cut waits behind the text clicks before it.
   */
  apply(
    ref: DraftRef,
    target: ChangeTarget,
    restore = false,
    /**
     * The item's tree cut, when the click includes its move, delete or creation: the tree line,
     * a whole-item Apply, or text groups chosen with the tree line.
     */
    requested?: { revision: string | null },
  ): { sent: boolean; outcome: Promise<CommandOutcome> } {
    return this.captureApply(ref, target, restore, requested)?.release() ?? this.blockedApply();
  }

  /**
   * Freezes one click without sending it. Apply all calls this for every item in its event turn,
   * then dispatches the captured clicks in server order; a single Apply uses the same path.
   */
  captureApply(
    ref: DraftRef,
    target: ChangeTarget,
    restore = false,
    requested?: { revision: string | null },
  ): CapturedApply | null {
    if (!this.active || this.state(ref.itemKey).discarding) return null;
    // A tree cut already on its way is not sent twice; the same revision would answer `changed`.
    const tree = this.items.get(ref.itemKey)?.queue.clicks.some((click) => click.body.tree)
      ? undefined
      : requested;
    const entry = this.byItem.get(ref.itemKey);
    // No text to apply with it (no room open, or no change in it): the tree cut alone.
    const textless =
      target.kind === "tree" ||
      (target.kind === "draft" &&
        requested !== undefined &&
        !(
          entry?.binding?.runtime.state().ready && entry.binding.runtime.projectNow()?.groups.length
        ));
    if (textless) return tree ? this.captureTree(ref, tree, restore) : null;
    return this.captureText(ref, target, restore, tree);
  }

  private blockedApply() {
    return {
      sent: false,
      outcome: Promise.resolve<CommandOutcome>({ kind: "blocked" }),
    };
  }

  private capturedOutcome(outcome: CommandOutcome): CapturedApply {
    return {
      release: () => ({ sent: false, outcome: Promise.resolve(outcome) }),
    };
  }

  /** A tree cut alone (design-v2 §4): no room, no snapshot, its applied answer settles it. */
  private captureTree(
    ref: DraftRef,
    tree: { revision: string | null },
    restore: boolean,
  ): CapturedApply {
    const id = this.generation(ref.itemKey);
    const frozen: FrozenApply = {
      body: {
        commandId: crypto.randomUUID(),
        groupIds: [],
        baseViewDelta: [],
        // The cut is the revision alone: the list item's `tree` also says what it does.
        tree: { revision: tree.revision },
        ...(restore ? { restore: true as const } : {}),
      },
      optimistic: [],
      patched: [],
      acknowledged: Promise.resolve(),
    };
    const barrier = sendBarrier();
    this.setState(ref.itemKey, { hidden: true, failure: null }, id);
    const queued = this.item(ref)
      .queue.enqueue(frozen, barrier.promise)
      .then((answer) => {
        this.setState(ref.itemKey, { hidden: false }, id);
        return this.settled(ref, id, answer);
      });
    let released = false;
    return {
      release: ({ omitTree = false, cancel = false } = {}) => {
        if (!released) {
          released = true;
          barrier.release({ omitTree, cancel: cancel || omitTree });
        }
        return {
          sent: !cancel && !omitTree,
          outcome: cancel || omitTree ? Promise.resolve({ kind: "done" }) : queued,
        };
      },
    };
  }

  private captureText(
    ref: DraftRef,
    target: TextTarget,
    restore: boolean,
    tree: { revision: string | null } | undefined,
  ): CapturedApply | null {
    const entry = this.byItem.get(ref.itemKey);
    const binding = entry?.binding;
    if (!entry || !binding?.runtime.state().ready || this.records.get(entry.draftId)?.closed)
      return null;
    const frame = binding.runtime.projectNow();
    if (!frame) return null;
    if (
      target.kind === "groups" &&
      (!blocksEqual(frame.diff.base.blocks, target.frame.diff.base.blocks) ||
        !blocksEqual(frame.diff.draft.blocks, target.frame.diff.draft.blocks))
    ) {
      this.setState(ref.itemKey, {
        failure: { code: "apply-refused", serverCode: "review_updated" },
      });
      return this.capturedOutcome({ kind: "change-refused", code: "review_updated" });
    }
    const ids = target.kind === "draft" ? frame.groups.map((group) => group.id) : target.groupIds;
    if (!ids.length || ids.some((id) => !frame.groups.some((group) => group.id === id)))
      return null;
    const schema = frame.doc.type.schema;
    const optimistic = frame.diff.base.blocks;
    const patched = applySpanPatches(
      optimistic,
      composeGroups(schema, frame, ids, "apply"),
      "base",
    );
    const body: ApplyClick = {
      commandId: crypto.randomUUID(),
      draftId: entry.draftId,
      snapshot: base64(Y.encodeSnapshotV2(Y.snapshot(binding.session.document))),
      groupIds: [...ids],
      baseViewDelta: baseViewDelta(
        schema,
        readBase(binding.session.document, schema),
        optimistic,
      ).map((patch) => ({ ...patch, blocks: patch.blocks.map((block) => block.toJSON()) })),
      ...(restore ? { restore: true as const } : {}),
      ...(tree ? { tree: { revision: tree.revision } } : {}),
    };
    const acknowledged = binding.session.whenCurrentChangesAcknowledged();
    const barrier = sendBarrier();
    this.setState(ref.itemKey, { failure: null });
    const result = entry.item.queue.enqueue(
      { body, optimistic, patched, acknowledged },
      barrier.promise,
    );
    binding.runtime.projectNow();
    const outcome = result.then((answer) => this.settled(ref, entry.draftId, answer));
    let released = false;
    return {
      release: ({ omitTree = false, cancel = false } = {}) => {
        if (!released) {
          released = true;
          barrier.release({ omitTree, cancel });
        }
        return { sent: !cancel, outcome: cancel ? Promise.resolve({ kind: "done" }) : outcome };
      },
    };
  }

  /** Releases a captured batch in server order while every intent remains owner-held. */
  async releaseBatch(
    items: readonly { itemKey: string; command: CapturedApply | null }[],
  ): Promise<CommandOutcome[]> {
    const settledTrees = new Set<string>();
    const outcomes: CommandOutcome[] = [];
    for (const { itemKey, command } of items) {
      const omitTree = settledTrees.has(itemKey);
      const outcome = await (command?.release({ omitTree }).outcome ??
        Promise.resolve<CommandOutcome>({ kind: "blocked" }));
      outcomes.push(outcome);
      if (outcome.kind === "done")
        for (const item of outcome.applied ?? [])
          if (item.transition) settledTrees.add(item.itemKey);
    }
    return outcomes;
  }

  /** The caller selects history ownership, never whether an editor happens to be mounted. */
  discard(
    ref: DraftRef,
    target: TextTarget,
    surface: "editor" | "dock",
    onNoticeEnd?: () => void,
  ): { notice: DiscardNotice; outcome: Promise<CommandOutcome> } | null {
    const entry = this.byItem.get(ref.itemKey);
    return startDraftDiscardSession({
      ref,
      target,
      surface,
      onNoticeEnd,
      entry,
      registry: this.registry,
      active: () => this.active,
      state: () => this.state(ref.itemKey),
      setState: (state) => this.setState(ref.itemKey, state),
      textClicks: () => (entry ? this.textClicks(entry) : []),
      releaseIdle: () => {
        if (entry) this.releaseIdle(entry);
      },
    });
  }

  retry(itemKey: string) {
    this.items.get(itemKey)?.queue.retry();
  }
  /** Server-only lifecycle commands share this account owner, never the Apply-all route. */
  async removeCreated(ref: DraftRef, item: ThreadDraftListItem): Promise<CommandOutcome> {
    if (!this.active || !item.isNew) return { kind: "blocked" };
    const settleOwn = this.lifecycle.markOwnRemoval?.(ref);
    this.setState(ref.itemKey, { hidden: true, failure: null });
    this.lifecycle.closeCreated?.(ref);
    try {
      const result = await discardCreatedDraft(ref, {
        branchId: item.branchId,
        itemKey: item.itemKey,
        commandId: crypto.randomUUID(),
      });
      if (!this.active) return { kind: "blocked" };
      if (result.status === "discarded") {
        settleOwn?.("removed");
        return { kind: "done" };
      }
      settleOwn?.("kept");
      this.setState(ref.itemKey, {
        hidden: false,
        failure: shownRefusal({ code: "discard-refused", serverCode: result.status }),
      });
      return { kind: "change-refused", code: result.status };
    } catch {
      settleOwn?.("kept");
      if (this.active)
        this.setState(ref.itemKey, { hidden: false, failure: { code: "discard-unknown" } });
      return { kind: "change-refused", code: "unknown" };
    }
  }
  /**
   * An item's Discard when its branch moves or deletes the document: the move or delete (its
   * tree line) and, unless only the line was chosen, the chosen text, as one command. The
   * server drops the row's facts and settles them, which no Undo reverses (#763), so the text
   * offers none either: it would bring back the text without the move or delete. Its notice
   * ends here; the accepted write keeps its paint opportunity and releases its room after.
   */
  discardItem(
    ref: DraftRef,
    item: ThreadDraftListItem,
    target: ChangeTarget,
    surface: "editor" | "dock",
  ): Promise<CommandOutcome> {
    if (!this.active || !item.tree) return Promise.resolve({ kind: "blocked" });
    const text =
      item.hasDraft && target.kind !== "tree" ? this.discard(ref, target, surface) : null;
    text?.notice.end();
    return Promise.all([this.discardTree(ref, item), text?.outcome]).then(([tree, discarded]) =>
      tree.kind === "done" && discarded ? discarded : tree,
    );
  }

  private async discardTree(ref: DraftRef, item: ThreadDraftListItem): Promise<CommandOutcome> {
    if (!this.active || !item.tree) return { kind: "blocked" };
    try {
      const result = await discardCreatedDraft(ref, {
        branchId: item.branchId,
        itemKey: item.itemKey,
        commandId: crypto.randomUUID(),
      });
      if (!this.active) return { kind: "blocked" };
      if (result.status === "discarded") return { kind: "done" };
      this.setState(ref.itemKey, {
        failure: shownRefusal({ code: "discard-refused", serverCode: result.status }),
      });
      return { kind: "change-refused", code: result.status };
    } catch {
      if (this.active) this.setState(ref.itemKey, { failure: { code: "discard-unknown" } });
      return { kind: "change-refused", code: "unknown" };
    }
  }
  async discardAll(refs: readonly DraftRef[], branchId: string): Promise<CommandOutcome> {
    const ref = refs[0];
    if (!this.active || !ref || this.closingWorks.has(ref.workId)) return { kind: "blocked" };
    this.closingWorks.add(ref.workId);
    const scope = new Map(refs.map((draft) => [draft.itemKey, draft]));
    for (const entry of this.entries.values())
      if (entry.ref.projectId === ref.projectId && entry.ref.workId === ref.workId)
        scope.set(entry.ref.itemKey, entry.ref);
    for (const draft of scope.values())
      this.setState(draft.itemKey, { hidden: true, failure: null });
    try {
      const answer = await discardWorkDrafts(ref, { branchId, commandId: crypto.randomUUID() });
      if (answer.status !== "discarded") throw new Error("Drafts no longer active");
      return { kind: "done" };
    } catch {
      if (this.active)
        for (const draft of scope.values())
          this.setState(draft.itemKey, { hidden: false, failure: { code: "discard-unknown" } });
      return { kind: "change-refused", code: "unknown" };
    } finally {
      this.closingWorks.delete(ref.workId);
    }
  }
  close() {
    this.active = false;
    for (const item of this.items.values()) item.queue.close();
  }
}
