/**
 * Account-lifetime command ownership. Each review item owns one frozen FIFO for its text, tree
 * and text+tree clicks; each draft room is a resource the item attaches, with its optimistic base.
 */
import { applyBase } from "@meridian/agent-edit/content-merge";
import {
  APPLY_RECORD_ROOT,
  applySpanPatches,
  baseViewDelta,
  blocksEqual,
  composeGroups,
  readApplyRecord,
} from "@meridian/agent-edit/diff";
import { type BranchId, draftItemKey, parseDraftItemKey } from "@meridian/contracts";
import type {
  ApplyClick,
  ApplyClickAnswer,
  DraftMetadataResponse,
  ThreadDraftListItem,
  UnapplyClick,
} from "@meridian/contracts/branches";
import { draftRoomName, parseYjsRoomName } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import {
  applyDraftClick,
  applyItems,
  branchOf,
  discardBranch,
  discardDraftItem,
  observeDraftClick,
  unapplyDraftClick,
} from "@/client/api/branches-api";
import { type DocumentSession, isSignInLapse } from "@/core/editor/document-session";
import {
  type DraftRoomRead,
  type DraftRoomRegistry,
  readDraftRoom,
} from "@/core/editor/draft-room-read";
import { type ApplyClickOutcome, ApplyClickQueue, type FrozenApply } from "./apply-click-queue";
import { BandApply, type LiveHistories } from "./apply-history";
import { DiscardRestores } from "./discard-restores";
import { startDraftDiscardSession } from "./draft-discard-session";
import { type DiscardUndo, DraftNotices } from "./draft-notices";
import { GroupApply } from "./group-apply";
import type { BranchCommandFailure, DraftRef } from "./review-command-types";
import { readBase } from "./review-frame";
import type { ChangeTarget, GroupsTarget, ReviewChange, TextTarget } from "./review-model";
import { type ReviewRuntime, retainReviewRuntime } from "./review-runtime";

export type DraftCommandState = {
  applying: boolean;
  unapplying: boolean;
  stalled: boolean;
  pending: boolean;
  hidden: boolean;
  discarding: ((change: ReviewChange) => boolean) | null;
  failure: BranchCommandFailure | null;
  /** How the draft ended, once it has; null while it is open. */
  ended: DraftEnd | null;
  checkingClose: boolean;
};
/**
 * What closed a draft, which decides what the page does: `here`, this tab's own Discard (the page
 * leaves for Live, where the notice has the Undo); `in-trash`, a Discard anywhere else (the draft
 * stays on screen, read-only, with Restore); `document`, its document went to Trash (the draft
 * stays with the document's Restore); `other`, anything else, such as a purge (the page leaves).
 */
export type DraftEnd = "here" | "in-trash" | "document" | "other";
/** An ended draft the page keeps showing, with its Restore. */
export function staysOnScreen(end: DraftEnd | null): boolean {
  return end === "in-trash" || end === "document";
}
const EMPTY: DraftCommandState = {
  applying: false,
  unapplying: false,
  stalled: false,
  pending: false,
  hidden: false,
  discarding: null,
  failure: null,
  ended: null,
  checkingClose: false,
};
export type CommandOutcome =
  | { kind: "blocked" }
  | {
      kind: "done";
      /** The Apply command that landed it, which an Un-Apply names. */
      commandId?: string;
      /** The document had been deleted from the manuscript and this Apply brought it back. */
      restored?: true;
      /** Per-item facts committed by this click. */
      applied?: {
        itemKey: string;
        transition?: { from: string | null; to: string | null };
        renamed?: string;
      }[];
    }
  /**
   * The document was deleted and the click didn't say the writer knew: nothing changed. In an
   * Apply of several, every item answers it; `deleted` marks the ones live deleted.
   */
  | { kind: "needs-restore"; deleted?: true }
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
/** A click that is one member of a several-item Apply: it takes the group's id and send. */
type Joint = { commandId: string; send(body: ApplyClick): Promise<ApplyClickAnswer> };
export type StartedApply = { sent: boolean; outcome: Promise<CommandOutcome> };
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

const RESOLVE_RETRY_MS = 1_000;
const RESOLVE_RETRY_MAX_MS = 30_000;

export class DraftCommandOwner {
  private readonly items = new Map<string, Item>();
  private readonly entries = new Map<string, Entry>();
  /** Band Applies in force or taken back, while their Ctrl+Z or Redo can still run. */
  private readonly bandApplies = new Set<BandApply>();
  private readonly byItem = new Map<string, Entry>();
  private readonly identities = new Map<string, string>();
  private readonly records = new Map<string, DraftCommandState>();
  private readonly listeners = new Set<() => void>();
  private readonly closingBranches = new Set<string>();
  private readonly resolvingGone = new Map<string, Promise<void>>();
  private readonly reconciling = new Map<string, Promise<boolean>>();
  /** Drafts (by id, or item key before one is known) this tab's own Discard ended. */
  private readonly discardedHere = new Set<string>();
  /** When this tab saw each draft end: a server answer after it may show the draft open again. */
  private readonly endedAt = new Map<string, number>();
  /** Documents an Apply brought back from a delete, until dismissed or another document shows. */
  private readonly restoredDocuments = new Set<string>();
  /** Final paths allocated by Apply, until dismissed or another document shows. */
  private readonly renamedDocuments = new Map<string, string>();
  private active = true;
  private revision = 0;
  /** Each Discard's restore, whatever sent it: the one progress every view reads. */
  readonly restores = new DiscardRestores();
  /** One notice per draft owner, outliving the surface that made it. */
  readonly notices = new DraftNotices(this.restores);
  constructor(
    private readonly registry: DraftRoomRegistry & {
      closeDraftRoom(roomKey: string): Promise<void>;
      /** A restore reopened the draft: the page may open its room again. */
      reopenDraftRoom(roomKey: string): void;
    },
    private readonly lifecycle: {
      /**
       * What became of a draft whose room closed or whose metadata answered gone, read from the
       * server now: `open` when it holds the draft open (a restore that arrived before the close),
       * null when it can't tell yet; a rejection is a failed read. Neither decides an end.
       */
      resolveEnd?(
        ref: DraftRef,
        draftId: string,
      ): Promise<Exclude<DraftEnd, "here"> | "open" | null>;
      /** Settles once the draft's document has left Trash (restored), however that happened. */
      documentBack?(ref: DraftRef): Promise<void>;
      closeCreated?(ref: DraftRef): void;
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
  /** How a draft ended, by its id: what a surface showing its room tells the writer. */
  endOf(draftId: string): DraftEnd | null {
    return this.records.get(draftId)?.ended ?? null;
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
        lookup: observeDraftClick,
        unapply: (body) => unapplyDraftClick(ref, body),
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
    const unapplying = queue.unapplies.length > 0;
    const stalled = queue.stalled;
    this.setState(ref.itemKey, {
      pending: queue.pending,
      applying: queue.applying,
      unapplying,
      stalled,
      ...(stalled && unapplying
        ? { failure: { code: "unapply-refused" as const, serverCode: "unknown" } }
        : {}),
    });
  }

  /** The clicks a draft's room records and its optimistic base folds, in FIFO order. */
  private textClicks(entry: Entry) {
    return entry.item.queue.clicks.filter((click) => click.body.draftId === entry.draftId);
  }

  /** A draft with clicks outstanding keeps its room read, surface or not, to observe their record. */
  private holdRoom(entry: Entry) {
    const pending =
      this.textClicks(entry).length > 0 ||
      entry.item.queue.unapplies.some((command) => command.draftId === entry.draftId);
    if (pending && !entry.lease) {
      const lease = readDraftRoom(this.registry, {
        roomKey: entry.roomKey,
        documentId: entry.ref.documentId,
      });
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
      return entry.item.queue.project(
        entry.draftId,
        readBase(session.document, schema),
        (base, before, after) => applyBase(schema, base, before, after),
      );
    });
    const record = session.document.getArray(APPLY_RECORD_ROOT);
    const observe = () => {
      binding.runtime.invalidateBase();
      const rows = readApplyRecord(session.document);
      this.publishQueue(entry.item);
      entry.item.queue.observe(
        entry.draftId,
        rows.flatMap((row) =>
          row.commandId ? [{ commandId: row.commandId, groupId: row.groupId }] : [],
        ),
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
        void this.resolveEnd(entry.ref, entry.draftId);
      } else if (
        snapshot.status === "destroyed" ||
        connection?.kind === "reset" ||
        connection?.kind === "terminal" ||
        (connection?.kind === "unauthorized" && !isSignInLapse(connection))
      ) {
        this.detach(entry);
        entry.item.queue.refuseUnsent(entry.draftId);
      }
      // A released room is kept while it holds typing it can still send; this lets it go.
      this.releaseIdle(entry);
    });
    // subscribe publishes synchronously, including an already retired session.
    if (entry.binding !== binding) stopSession();
    else observe();
  }

  /** Whether an Apply brought this document back from a delete. */
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
   * them active, so their tabs stay; the review list lags, this does not.
   */
  boundDrafts(projectId: string, documentId: string): DraftRef[] {
    return [...this.entries.values()].flatMap(({ ref, draftId, binding }) =>
      binding &&
      ref.projectId === projectId &&
      ref.documentId === documentId &&
      !this.records.get(draftId)?.ended
        ? [ref]
        : [],
    );
  }

  /**
   * Ask what became of the draft: its metadata answered `gone`, or a page holding it saw it
   * leave its list. The one check that asks the server, and asks again while a surface holds
   * the draft; it settles once the draft ended or the server holds it open. It concerns the
   * generation known when asked: a draft bound meanwhile is a newer one, and stays open.
   */
  askEnd(ref: DraftRef): Promise<void> {
    return this.resolveEnd(ref, this.generation(ref.itemKey));
  }

  /**
   * A draft's room closed, or its metadata answered gone: ask the server what became of it, in
   * whichever order the close and a restore arrived. This tab's own Discard needs no asking.
   */
  private resolveEnd(ref: DraftRef, id: string): Promise<void> {
    if (!this.active || this.records.get(id)?.ended) return Promise.resolve();
    const pending = this.resolvingGone.get(id);
    if (pending) return pending;
    if (this.discardedHere.has(id) || this.discardedHere.has(ref.itemKey)) {
      this.finishClose(ref, id, "here");
      return Promise.resolve();
    }
    const entry = this.entries.get(id);
    const lease = entry?.binding
      ? readDraftRoom(this.registry, {
          roomKey: entry.binding.session.roomKey,
          documentId: ref.documentId,
        })
      : null;
    if (entry) entry.users++;
    this.setState(ref.itemKey, { checkingClose: true }, id);
    const resolving = (async () => {
      // A failed read or an undecided answer decides nothing: the draft stays held, and is asked
      // about again while a surface shows it (and on its next `gone` metadata answer).
      for (let wait = RESOLVE_RETRY_MS; ; wait = Math.min(wait * 2, RESOLVE_RETRY_MAX_MS)) {
        let end: Exclude<DraftEnd, "here"> | "open" | null | undefined;
        try {
          end = await this.lifecycle.resolveEnd?.(ref, id);
        } catch {
          end = null;
        }
        if (end === undefined || !this.active || this.records.get(id)?.ended) return;
        if (end) {
          // A restore landed before this close: the session on screen joins the reopened draft.
          if (end === "open") this.registry.reopenDraftRoom(draftRoomName(id));
          else this.finishClose(ref, id, end);
          return;
        }
        if (!this.entries.get(id)?.binding) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    })().finally(() => {
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
   * Whether the item may open, asking the server when its known generation is closed (it ended,
   * or this tab's Discard hid it). The same draft active again is a restore, from any tab or
   * view: it reopens here (`metadataActive`). A different active draft is a replacement under the
   * same key: the item follows it. The closed generation's record (its unsent text, its queue) is
   * kept, and a failed read leaves the item closed. A Discard still in flight keeps it hidden.
   */
  reconcileClosed(ref: DraftRef, read: () => Promise<DraftMetadataResponse>): Promise<boolean> {
    const closedId = this.generation(ref.itemKey);
    const state = this.state(ref.itemKey);
    if (!state.ended && !(state.hidden && this.endedAt.has(closedId)))
      return Promise.resolve(this.active && !state.hidden);
    const pending = this.reconciling.get(ref.itemKey);
    if (pending) return pending;
    const asked = Date.now();
    const reconcile = read()
      .then((answer) => {
        if (!this.active || answer.status !== "active") return false;
        if (answer.draftId === closedId) return this.metadataActive(ref, closedId, asked);
        if (this.generation(ref.itemKey) === closedId) {
          this.identities.set(ref.itemKey, answer.draftId);
          this.publish();
          const item = this.items.get(ref.itemKey);
          if (item) this.publishQueue(item);
        }
        return !this.state(ref.itemKey).ended;
      })
      .catch(() => false)
      .finally(() => this.reconciling.delete(ref.itemKey));
    this.reconciling.set(ref.itemKey, reconcile);
    return reconcile;
  }

  /**
   * The server answers the draft open (`draftId`), at `at`, after this tab saw it end: a restore
   * reopened it, here or anywhere. Its ended state goes and its room may open again under the same
   * id, and the session still on screen joins it in place; a room the server still holds closed
   * refuses the join, which ends it again. True when the draft is open by this answer, whichever
   * reader brought the reopening: every reader the close left without a room asks again.
   */
  metadataActive(ref: DraftRef, draftId: string, at: number): boolean {
    if (!this.active) return false;
    const ended = [draftId, ref.itemKey].filter((key) => (this.endedAt.get(key) ?? at) < at);
    if (ended.length === 0) return !this.endedAt.has(draftId) && !this.endedAt.has(ref.itemKey);
    for (const key of ended) {
      this.endedAt.delete(key);
      this.discardedHere.delete(key);
      this.setState(
        ref.itemKey,
        {
          ended: null,
          hidden: false,
          checkingClose: false,
          failure: null,
        },
        key,
      );
    }
    if (this.identities.get(ref.itemKey) !== draftId) {
      this.identities.set(ref.itemKey, draftId);
      this.publish();
    }
    this.registry.reopenDraftRoom(draftRoomName(draftId));
    return true;
  }

  private finishClose(ref: DraftRef, id: string, end: DraftEnd) {
    const record = this.records.get(id) ?? EMPTY;
    if (!this.active || record.ended) return;
    const entry = this.entries.get(id);
    this.endedAt.set(id, Date.now());
    this.setState(ref.itemKey, { ended: end, checkingClose: false }, id);
    // Its document's restore brings back no draft: the page then leaves for the document.
    if (end === "document")
      void this.lifecycle.documentBack?.(ref).then(() => {
        if (this.active && this.records.get(id)?.ended === "document")
          this.setState(ref.itemKey, { ended: "other" }, id);
      });
    if (entry?.binding) for (const stop of entry.binding.notices) stop();
    // The server refuses an Un-Apply against an ended draft: Ctrl+Z goes past its Applies.
    for (const band of this.bandApplies) if (band.draftId === id) band.end();
    // Only this draft's clicks: the item's tree clicks and a newer draft's go on.
    this.items.get(ref.itemKey)?.queue.close(id);
    if (id !== ref.itemKey)
      void this.registry.closeDraftRoom(draftRoomName(id)).catch(() => undefined);
  }

  private releaseIdle(entry: Entry) {
    if (
      entry.users ||
      this.textClicks(entry).length ||
      entry.item.queue.unapplies.some((command) => command.draftId === entry.draftId) ||
      this.entries.get(entry.draftId) !== entry
    )
      return;
    this.detach(entry);
    this.entries.delete(entry.draftId);
    entry.item.rooms.delete(entry);
    if (this.byItem.get(entry.ref.itemKey) === entry) this.byItem.delete(entry.ref.itemKey);
    // The Apply stays in force after its review closes (Draft view to Live): its Ctrl+Z goes on
    // without the queue, which settles only by watching this room.
    const port = {
      send: (body: ApplyClick) => applyDraftClick(entry.ref, body),
      unapply: (body: UnapplyClick) => unapplyDraftClick(entry.ref, body),
    };
    for (const band of this.bandApplies) if (band.draftId === entry.draftId) band.release(port);
    this.releaseItem(entry.item);
  }

  private releaseItem(item: Item) {
    if (item.rooms.size || item.queue.pending || this.items.get(item.ref.itemKey) !== item) return;
    this.items.delete(item.ref.itemKey);
  }

  /** A click's answer, as its caller's outcome and a refusal on the generation it was made for. */
  private settled(
    ref: DraftRef,
    id: string,
    answer: ApplyClickOutcome,
    restore: boolean,
  ): CommandOutcome {
    if (answer.status !== "applied" && answer.status !== "landed" && answer.status !== "cancelled")
      this.setState(
        ref.itemKey,
        { failure: shownRefusal({ code: "apply-refused", serverCode: refusalCode(answer) }) },
        id,
      );
    return this.outcomeOf(ref, answer, restore);
  }

  /** `restore`: this click brought its document back, as a group's `restored` says of some. */
  private outcomeOf(ref: DraftRef, answer: ApplyClickOutcome, restore: boolean): CommandOutcome {
    if (answer.status === "applied") {
      const restored = answer.restored && restore;
      if (restored) {
        this.restoredDocuments.add(JSON.stringify([ref.projectId, ref.documentId]));
      }
      for (const item of answer.applied) {
        if (!item.renamed) continue;
        const documentId = parseDraftItemKey(item.itemKey)?.documentId;
        if (documentId)
          this.renamedDocuments.set(JSON.stringify([ref.projectId, documentId]), item.renamed.path);
      }
      if (restored || answer.applied.some((item) => item.renamed)) this.publish();
      return {
        kind: "done",
        commandId: answer.commandId,
        ...(restored ? { restored: true as const } : {}),
        applied: answer.applied.map((item) => ({
          itemKey: item.itemKey,
          ...(item.transition ? { transition: item.transition } : {}),
          ...(item.renamed ? { renamed: item.renamed.path } : {}),
        })),
      };
    }
    if (answer.status === "landed") return { kind: "done", commandId: answer.commandId };
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
    /** A band's Apply: the histories its Ctrl+Z goes in. */
    histories?: LiveHistories | null,
    joint?: Joint,
  ): StartedApply | null {
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
    if (textless) return tree ? this.captureTree(ref, tree, restore, joint) : null;
    return this.captureText(ref, target, restore, tree, histories, joint);
  }

  /** A tree cut alone (design-v2 §4): no room, no snapshot, its applied answer settles it. */
  private captureTree(
    ref: DraftRef,
    tree: { revision: string | null },
    restore: boolean,
    joint?: Joint,
  ): StartedApply {
    const id = this.generation(ref.itemKey);
    const frozen: FrozenApply = {
      ...(joint ? { send: joint.send } : {}),
      body: {
        commandId: joint?.commandId ?? crypto.randomUUID(),
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
    this.setState(ref.itemKey, { hidden: true, failure: null }, id);
    const outcome = this.item(ref)
      .queue.enqueue(frozen)
      .then((answer) => {
        this.setState(ref.itemKey, { hidden: false }, id);
        return this.settled(ref, id, answer, restore);
      });
    return { sent: true, outcome };
  }

  private captureText(
    ref: DraftRef,
    target: TextTarget,
    restore: boolean,
    tree: { revision: string | null } | undefined,
    histories?: LiveHistories | null,
    joint?: Joint,
  ): StartedApply | null {
    const entry = this.byItem.get(ref.itemKey);
    const binding = entry?.binding;
    if (!entry || !binding?.runtime.state().ready || this.records.get(entry.draftId)?.ended)
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
      return {
        sent: false,
        outcome: Promise.resolve({ kind: "change-refused", code: "review_updated" }),
      };
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
      commandId: joint?.commandId ?? crypto.randomUUID(),
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
    this.setState(ref.itemKey, { failure: null });
    const frozen: FrozenApply = {
      body,
      optimistic,
      patched,
      acknowledged,
      ...(joint ? { send: joint.send } : {}),
    };
    const scheduled = histories
      ? entry.item.queue.enqueueHistory({
          frozen,
          patchFor: (groupIds) =>
            applySpanPatches(optimistic, composeGroups(schema, frame, groupIds, "apply"), "base"),
          intent: () => this.setState(entry.ref.itemKey, { failure: null }),
          applyRefused: (answer) =>
            this.setState(entry.ref.itemKey, {
              failure: {
                code: "apply-refused",
                serverCode: answer.status === "applied" ? "text_not_applied" : refusalCode(answer),
              },
            }),
          unapplyRefused: (answer) =>
            this.setState(entry.ref.itemKey, {
              failure: { code: "unapply-refused", serverCode: answer.status },
            }),
        })
      : { outcome: entry.item.queue.enqueue(frozen), handle: null };
    if (scheduled.handle && histories) {
      const band = new BandApply(entry.draftId, histories, scheduled.handle, () =>
        this.bandApplies.delete(band),
      );
      this.bandApplies.add(band);
    }
    binding.runtime.projectNow();
    const outcome = scheduled.outcome.then((answer) =>
      this.settled(ref, entry.draftId, answer, restore),
    );
    return { sent: true, outcome };
  }

  /**
   * Several documents and folders as one Apply command (`GroupApply`): an Apply all, a folder's
   * ✓. Every document's click is frozen in this event turn, as a single Apply's is, and waits in
   * its own queue; a folder's is a tree cut in its own item's queue (`folderKey`), so a folder
   * shows pending, refused and unknown delivery as a document does. `members[i]`'s outcome is
   * `outcomes[i]`, then `folders[j]`'s. `restore` is whether the writer chose to bring back what
   * live deleted; a member's own `restore` says whether it is one of those.
   */
  applyGroup(input: {
    projectId: string;
    ownerKey: string;
    branchId: string;
    members: readonly {
      ref: DraftRef;
      target: ChangeTarget;
      restore: boolean;
      tree?: { revision: string | null };
    }[];
    folders: readonly string[];
    /** The folders' revisions of the Work's row, read once when the command goes. */
    revisions: () => Promise<ReadonlyMap<string, string>>;
    restore: boolean;
  }): {
    commandId: string;
    answer: Promise<ApplyClickAnswer | null>;
    outcomes: Promise<CommandOutcome>[];
  } {
    const group = new GroupApply(crypto.randomUUID(), {
      revisions: input.revisions,
      restore: input.restore,
      post: (body) => applyItems(input.projectId, input.branchId, body),
    });
    const joined = (started: StartedApply | null, member: { drop(): void }) => {
      if (!started) {
        member.drop();
        return Promise.resolve<CommandOutcome>({ kind: "blocked" });
      }
      void started.outcome.then(member.drop);
      return started.outcome;
    };
    const outcomes = input.members.map(({ ref, target, restore, tree }) => {
      const member = group.member(ref.documentId);
      return joined(
        this.apply(ref, target, restore, tree, null, {
          commandId: group.commandId,
          send: member.send,
        }),
        member,
      );
    });
    for (const node of input.folders) {
      const member = group.member(node, true);
      const ref = {
        projectId: input.projectId,
        ownerKey: input.ownerKey,
        documentId: node,
        itemKey: folderKey(input.branchId, node),
      };
      // A folder's cut already on its way is not sent twice.
      const busy = this.items.get(ref.itemKey)?.queue.pending ?? false;
      outcomes.push(
        joined(
          busy
            ? null
            : this.captureTree(ref, { revision: null }, false, {
                commandId: group.commandId,
                send: member.send,
              }),
          member,
        ),
      );
    }
    group.sealed();
    return { commandId: group.commandId, answer: group.answer, outcomes };
  }

  /**
   * The caller names whose history also holds it: its own editor (Ctrl+Z), or none (`notice`).
   * The returned handle is the notice's Undo; the caller shows it or ends it.
   */
  discard(
    ref: DraftRef,
    target: GroupsTarget,
    history: Editor | "notice" | null,
  ): { handle: DiscardUndo | null; outcome: Promise<CommandOutcome> } | null {
    const entry = this.byItem.get(ref.itemKey);
    let handle: DiscardUndo | null = null;
    const started = startDraftDiscardSession({
      target,
      history,
      onNoticeEnd: () => {
        if (handle) this.notices.partEnded(handle);
      },
      entry,
      registry: this.registry,
      active: () => this.active,
      state: () => this.state(ref.itemKey),
      setState: (state) => this.setState(ref.itemKey, state),
      releaseIdle: () => {
        if (entry) this.releaseIdle(entry);
      },
    });
    handle = started?.handle ?? null;
    return started;
  }

  retry(itemKey: string) {
    if (this.items.get(itemKey)?.queue.stalled) this.setState(itemKey, { failure: null });
    this.items.get(itemKey)?.queue.retry();
  }
  /**
   * Discards a whole item on the server, every Discard of a whole draft: Trash lists it and its
   * Undo is the server's, by `commandId`. A created document leaves at once; any other stays in review,
   * discarding, until the server answers, so a refusal shows on it. A Discard decided on the
   * frozen reading names the draft the writer saw, so the server refuses it if the chat came
   * back and the draft moved on. Server-only lifecycle commands share this account owner, never
   * the Apply route.
   */
  async discardOnServer(
    ref: DraftRef,
    item: ThreadDraftListItem,
    frozen: boolean,
    commandId: string,
  ): Promise<CommandOutcome> {
    if (!this.active) return { kind: "blocked" };
    const own = this.generation(ref.itemKey);
    this.discardedHere.add(own);
    this.setState(
      ref.itemKey,
      item.isNew ? { hidden: true, failure: null } : { discarding: () => true, failure: null },
    );
    if (item.isNew) this.lifecycle.closeCreated?.(ref);
    try {
      const result = await discardDraftItem(ref, {
        branchId: item.branchId,
        itemKey: item.itemKey,
        commandId,
        ends: "item",
        ...(frozen ? { draftSeenAt: item.hasDraft ? item.updatedAt : null } : {}),
      });
      if (!this.active) return { kind: "blocked" };
      if (result.status === "discarded") {
        // State held under the item key itself (no draft room ever bound, as for a picture)
        // would hide the document's next item in this branch too; the caller drops the row.
        const hides = item.isNew || this.generation(ref.itemKey) !== ref.itemKey;
        if (hides) this.endedAt.set(this.generation(ref.itemKey), Date.now());
        this.setState(
          ref.itemKey,
          hides ? { hidden: true, discarding: null } : { discarding: null },
        );
        return { kind: "done" };
      }
      this.discardedHere.delete(own);
      this.setState(ref.itemKey, {
        hidden: false,
        discarding: null,
        failure: shownRefusal({ code: "discard-refused", serverCode: result.status }),
      });
      return { kind: "change-refused", code: result.status };
    } catch {
      this.discardedHere.delete(own);
      if (this.active)
        this.setState(ref.itemKey, {
          hidden: false,
          discarding: null,
          failure: { code: "discard-unknown" },
        });
      return { kind: "change-refused", code: "unknown" };
    }
  }
  /**
   * An item's Discard when its branch moves or deletes the document: the move or delete (its
   * tree line), discarded on the server as `commandId`, and unless only the line was chosen, the
   * chosen text, here. Its Undo takes back both: the text's `handle` and the server's command.
   * Null when the chosen text couldn't be written: the move or delete stays with it.
   */
  discardItem(
    ref: DraftRef,
    item: ThreadDraftListItem,
    target: GroupsTarget | { kind: "tree" },
    history: Editor | "notice" | null,
    commandId: string,
  ): { handle: DiscardUndo | null; outcome: Promise<CommandOutcome> } | null {
    if (!this.active || !item.tree) return null;
    const text =
      item.hasDraft && target.kind !== "tree" ? this.discard(ref, target, history) : null;
    if (item.hasDraft && target.kind !== "tree" && !text) return null;
    return {
      handle: text?.handle ?? null,
      outcome: Promise.all([this.discardTree(ref, item, commandId), text?.outcome]).then(
        ([tree, discarded]) => (tree.kind === "done" && discarded ? discarded : tree),
      ),
    };
  }

  private async discardTree(
    ref: DraftRef,
    item: ThreadDraftListItem,
    commandId: string,
  ): Promise<CommandOutcome> {
    if (!this.active || !item.tree) return { kind: "blocked" };
    try {
      const result = await discardDraftItem(ref, {
        branchId: item.branchId,
        itemKey: item.itemKey,
        commandId,
        ends: "tree",
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
  /**
   * The branch's Discard on the server, as `commandId`, which its Undo names: every change of the
   * branch (`all`, the one command that closes it), or exactly the selected nodes, documents and
   * folders, each ending as its `ends` says. What it takes hides until the answer; a refusal or
   * an unknown delivery shows on each item it named.
   */
  async discardBranch(input: {
    projectId: string;
    branchId: string;
    commandId: string;
    selection:
      | { all: true; refs: readonly DraftRef[] }
      | {
          items: readonly {
            ref: DraftRef;
            ends: "tree" | "item";
            draftSeenAt?: string | null;
          }[];
        };
  }): Promise<CommandOutcome> {
    const { projectId, branchId, commandId, selection } = input;
    if (!this.active || this.closingBranches.has(branchId)) return { kind: "blocked" };
    const scope = new Map(
      ("all" in selection ? selection.refs : selection.items.map(({ ref }) => ref)).map((ref) => [
        ref.itemKey,
        ref,
      ]),
    );
    if ("all" in selection)
      for (const entry of this.entries.values())
        if (entry.ref.projectId === projectId && branchOf(entry.ref.itemKey) === branchId)
          scope.set(entry.ref.itemKey, entry.ref);
    if (scope.size === 0) return { kind: "blocked" };
    // A Discard all closes the branch: nothing else is sent on it until it answers.
    if ("all" in selection) this.closingBranches.add(branchId);
    const own = [...scope.values()].map((ref) => this.generation(ref.itemKey));
    for (const key of own) this.discardedHere.add(key);
    for (const ref of scope.values()) this.setState(ref.itemKey, { hidden: true, failure: null });
    const failed = (failure: BranchCommandFailure | null) => {
      for (const key of own) this.discardedHere.delete(key);
      if (this.active)
        for (const ref of scope.values())
          this.setState(ref.itemKey, { hidden: false, failure: failure && shownRefusal(failure) });
    };
    try {
      const answer = await discardBranch(projectId, branchId, {
        commandId,
        ...("all" in selection
          ? { all: true as const }
          : {
              items: selection.items.map(({ ref, ends, draftSeenAt }) => ({
                node: ref.documentId,
                ends,
                ...(draftSeenAt !== undefined ? { draftSeenAt } : {}),
              })),
            }),
      });
      if (answer.status === "discarded") {
        // The caller drops the rows with this answer, as an item's server Discard does: the
        // keys stay live, since the Discard's Undo reopens the same items, even a closed branch's.
        for (const ref of scope.values()) this.setState(ref.itemKey, { hidden: false });
        return { kind: "done" };
      }
      failed({ code: "discard-refused", serverCode: answer.status });
      return { kind: "change-refused", code: answer.status };
    } catch {
      failed({ code: "discard-unknown" });
      return { kind: "change-refused", code: "unknown" };
    } finally {
      if ("all" in selection) this.closingBranches.delete(branchId);
    }
  }
  close() {
    this.active = false;
    this.notices.close();
    for (const item of this.items.values()) item.queue.close();
    // Their entries sit on sessions that outlive this owner.
    for (const band of this.bandApplies) band.end();
  }
}

/** A folder's item in a Work's branch: the key its commands' state is kept under. */
export const folderKey = (branchId: string, folderId: string): string =>
  draftItemKey(branchId as BranchId, folderId);
