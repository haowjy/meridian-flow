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
import {
  type BranchId,
  type DocumentId,
  draftItemKey,
  parseDraftItemKey,
} from "@meridian/contracts";
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyItemResult,
  DiscardCommandResult,
  DraftMetadataResponse,
  ThreadDraftListItem,
  TreeSaw,
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
import {
  type ApplyClickOutcome,
  ApplyClickQueue,
  type FrozenApply,
  frozenOn,
} from "./apply-click-queue";
import { BandApply, type LiveHistories } from "./apply-history";
import { DiscardRestores } from "./discard-restores";
import { startDraftDiscardSession } from "./draft-discard-session";
import {
  type ApplyHalves,
  type DiscardTook,
  type DiscardUndo,
  DraftNotices,
  halvesOf,
  itemOf,
  type RestoreReturned,
  returnedIn,
  viewOf,
} from "./draft-notices";
import { GroupApply } from "./group-apply";
import type { ApplyLine, BranchCommandFailure, DraftRef } from "./review-command-types";
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
      /** What of the whole command landed; unknown (the answer was never read): both halves. */
      halves?: ApplyHalves;
      /** Its tree half landed whole: nothing of its move, delete or creation is still pending. */
      treeWhole?: boolean;
      /** Each half's lines for what stayed out beside what landed. */
      lines?: ApplyLine[];
      /** The document had been live deleted and this Apply brought it back. */
      restored?: true;
      /** Per-item facts committed by this click. */
      applied?: {
        itemKey: string;
        transition?: { from: string | null; to: string | null };
      }[];
      /** A Discard's answer: what of what it was sent it took (`DiscardTook`). */
      took?: DiscardTook;
    }
  /** The server answered for this item and landed neither half: each half's lines say why. */
  | { kind: "settled"; lines: ApplyLine[]; took?: DiscardTook }
  /** A closed owner answered and changed nothing: the surface says why, once. */
  | { kind: "returned"; why: RestoreReturned }
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
/**
 * A click that is one member of a several-item Apply: it takes the group's id and send, and
 * hands back whatever answer its queue settles on, however it came (`GroupApply.answered`).
 */
type Joint = {
  commandId: string;
  send(body: ApplyClick): Promise<ApplyClickAnswer>;
  answered(answer: ApplyClickOutcome): void;
};
export type StartedApply = { sent: boolean; outcome: Promise<CommandOutcome> };
/**
 * A Discard's answer for the documents it was sent. `done` when it took something, `settled` when
 * each item was settled before it, `returned` when a closed owner changed nothing. `untaken`: the
 * items it found settled; `lines`: each item's own lines (a delete that took it first), by
 * document; an Apply that took one first is the notice's to say (`took.appliedFirst`), not a
 * line. `already` is quiet and gives none; a line naming no item covers every one sent.
 */
function discardAnswer(
  result: DiscardCommandResult,
  documentIds: readonly string[],
): {
  outcome: CommandOutcome;
  untaken: ReadonlySet<string>;
  lines: ReadonlyMap<string, ApplyLine[]>;
} {
  const why = returnedIn(result.settled);
  if (why) return { outcome: { kind: "returned", why }, untaken: new Set(), lines: new Map() };
  const untaken = new Set<string>();
  const appliedFirst = new Set<string>();
  const lines = new Map<string, ApplyLine[]>();
  for (const one of result.settled ?? []) {
    if (one.rule !== "already" && one.rule !== "overtaken") continue;
    const view = viewOf(one);
    for (const item of one.item ? [one.item] : documentIds) {
      untaken.add(item);
      if (view?.kind !== "overtaken") continue;
      if (view.state === "applied") appliedFirst.add(item);
      else
        lines.set(item, [
          ...(lines.get(item) ?? []),
          { half: "tree", code: `overtaken_${view.state}`, by: view.by },
        ]);
    }
  }
  const took = { untaken: [...untaken], appliedFirst: [...appliedFirst] };
  return {
    outcome: documentIds.some((id) => !untaken.has(id))
      ? { kind: "done", took }
      : { kind: "settled", lines: [...lines.values()].flat(), took },
    untaken,
    lines,
  };
}
const leftOut = (lines: readonly ApplyLine[] | undefined): BranchCommandFailure | null =>
  lines?.length ? { code: "apply-left-out", landed: false, lines } : null;
/**
 * Every line an item shows for what of it didn't land, each with its half: `overtaken_<state>`
 * or `left_out_<why>`. `already` and `restored` are painted quietly and give none.
 */
function linesOf(item: ApplyItemResult | undefined): ApplyLine[] {
  return (["tree", "text"] as const).flatMap((half) =>
    (item?.[half]?.settled ?? []).flatMap((one): ApplyLine[] => {
      const view = viewOf(one);
      if (view?.kind === "overtaken")
        return [{ half, code: `overtaken_${view.state}`, by: view.by }];
      if (view?.kind === "left_out") return [{ half, code: `left_out_${view.why}` }];
      return [];
    }),
  );
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
        node: ref.documentId,
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
    return entry.item.queue.clicks.filter((click) => frozenOn(click, entry.draftId));
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

  forgetApplyFacts(projectId: string, documentId: string): void {
    if (this.restoredDocuments.delete(JSON.stringify([projectId, documentId]))) this.publish();
  }

  /** The writer moved on to `documentId`: every other document's Apply fact ends. */
  keepApplyFactsOnly(projectId: string, documentId: string): void {
    const kept = JSON.stringify([projectId, documentId]);
    let changed = false;
    for (const key of this.restoredDocuments)
      if (key !== kept) changed = this.restoredDocuments.delete(key) || changed;
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

  /** A click's answer, as its caller's outcome and a line on the generation it was made for. */
  private settled(ref: DraftRef, id: string, answer: ApplyClickOutcome): CommandOutcome {
    const outcome = this.outcomeOf(ref, answer);
    const failure: BranchCommandFailure | null =
      (outcome.kind === "settled" || outcome.kind === "done") && outcome.lines?.length
        ? { code: "apply-left-out", landed: outcome.kind === "done", lines: outcome.lines }
        : outcome.kind === "change-refused"
          ? { code: "apply-refused", serverCode: outcome.code }
          : null;
    if (failure) this.setState(ref.itemKey, { failure }, id);
    return outcome;
  }

  /**
   * One item's outcome from its entry in the answer: done when either half landed (it gets the
   * Undo step and the applied facts), settled when neither did. Every line of both halves goes
   * with it, so a landed delete with a left-out rename reads as applied, with the line.
   */
  private outcomeOf(ref: DraftRef, answer: ApplyClickOutcome): CommandOutcome {
    if (answer.status === "applied") {
      const item = itemOf(answer, ref.documentId);
      const lines = linesOf(item);
      const tree = item?.tree?.landed === true;
      if (!tree && item?.text?.landed !== true) return { kind: "settled", lines };
      const treeWhole = tree && !item?.tree?.settled?.some((one) => one.rule === "left_out");
      const restored = [...(item?.tree?.settled ?? []), ...(item?.text?.settled ?? [])].some(
        (one) => one.rule === "restored",
      );
      if (restored) this.restoredDocuments.add(JSON.stringify([ref.projectId, ref.documentId]));
      const branchId = parseDraftItemKey(ref.itemKey)?.branchId;
      if (restored) this.publish();
      return {
        kind: "done",
        commandId: answer.commandId,
        halves: halvesOf(answer),
        treeWhole,
        lines,
        ...(restored ? { restored: true as const } : {}),
        applied: branchId
          ? answer.items.flatMap((one) =>
              one.tree?.landed || one.text?.landed
                ? [
                    {
                      itemKey: draftItemKey(branchId, one.node as DocumentId),
                      ...(one.tree?.landed && one.tree.transition
                        ? { transition: one.tree.transition }
                        : {}),
                    },
                  ]
                : [],
            )
          : [],
      };
    }
    if (answer.status === "landed") return { kind: "done", commandId: answer.commandId };
    if (answer.status === "cancelled") return { kind: "blocked" };
    return { kind: "change-refused", code: "unsynced" };
  }

  /**
   * No await before snapshot, group validation, O, P and acknowledgement barrier are frozen.
   * Every click joins the item's one FIFO, so a tree cut waits behind the text clicks before it.
   * `saw` is what the tree lists held at the press.
   */
  apply(
    ref: DraftRef,
    target: ChangeTarget,
    /**
     * Whether the click includes the item's tree records, its move, delete or creation: the
     * tree line, a whole-item Apply, or text groups chosen with the tree line.
     */
    requested: boolean,
    saw: TreeSaw | undefined,
    /** A band's Apply: the histories its Ctrl+Z goes in. */
    histories?: LiveHistories | null,
    joint?: Joint,
  ): StartedApply | null {
    if (!this.active || this.state(ref.itemKey).discarding) return null;
    // A tree cut already on its way is not sent twice.
    const tree =
      requested && !this.items.get(ref.itemKey)?.queue.clicks.some((click) => click.body.tree);
    const binding = this.byItem.get(ref.itemKey)?.binding;
    const room = binding?.runtime.state().ready ? binding : null;
    // No room open here: the server cuts the whole draft on receipt.
    const whole = target.kind === "draft" && !room ? target.draftId : undefined;
    // The tree cut alone: no text asked for, or none to apply (no draft, or a room with no change).
    const textless =
      target.kind === "tree" ||
      (target.kind === "draft" && requested && !room?.runtime.projectNow()?.groups.length);
    if (whole || textless)
      return whole || tree
        ? this.captureOnReceipt(ref, { draftId: whole, tree }, saw, joint)
        : null;
    return this.captureText(ref, target, tree, saw, histories, joint);
  }

  /**
   * A click the server resolves on receipt, so it needs no room: a tree cut alone (design-v2
   * §4), or every change of `draftId` as the server holds it then, with the item's tree cut when
   * given. Text an agent writes before the server receives it is included. The row hides until
   * the answer.
   */
  private captureOnReceipt(
    ref: DraftRef,
    cut: { draftId?: string; tree?: boolean },
    saw: TreeSaw | undefined,
    joint?: Joint,
  ): StartedApply | null {
    if (cut.draftId && this.records.get(cut.draftId)?.ended) return null;
    const id = this.generation(ref.itemKey);
    const frozen: FrozenApply = {
      ...(joint ? { send: joint.send } : {}),
      body: {
        commandId: joint?.commandId ?? crypto.randomUUID(),
        ...(cut.draftId ? { draftId: cut.draftId, whole: true as const } : {}),
        groupIds: [],
        baseViewDelta: [],
        ...(cut.tree ? { tree: true as const } : {}),
        ...(saw ? { saw } : {}),
      },
      optimistic: [],
      patched: [],
      acknowledged: Promise.resolve(),
    };
    this.setState(ref.itemKey, { hidden: true, failure: null }, id);
    const outcome = this.item(ref)
      .queue.enqueue(frozen)
      .then((answer) => {
        joint?.answered(answer);
        this.setState(ref.itemKey, { hidden: false }, id);
        return this.settled(ref, id, answer);
      });
    return { sent: true, outcome };
  }

  private captureText(
    ref: DraftRef,
    target: TextTarget,
    tree: boolean,
    saw: TreeSaw | undefined,
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
      ...(tree ? { tree: true as const } : {}),
      ...(saw ? { saw } : {}),
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
          replayed: (answer) => void this.settled(entry.ref, entry.draftId, answer),
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
    const outcome = scheduled.outcome.then((answer) => {
      joint?.answered(answer);
      return this.settled(ref, entry.draftId, answer);
    });
    return { sent: true, outcome };
  }

  /**
   * Several documents and folders as one Apply command (`GroupApply`): an Apply all, a folder's
   * ✓. Every document's click is frozen in this event turn, as a single Apply's is, and waits in
   * its own queue; a folder's is a tree cut in its own item's queue (`folderKey`), so a folder
   * shows pending, refused and unknown delivery as a document does. `members[i]`'s outcome is
   * `outcomes[i]`, then `folders[j]`'s. `saw` is what the tree lists held at the press.
   */
  applyGroup(input: {
    projectId: string;
    ownerKey: string;
    branchId: string;
    members: readonly {
      ref: DraftRef;
      target: ChangeTarget;
      tree: boolean;
    }[];
    folders: readonly string[];
    saw: TreeSaw | undefined;
  }): {
    commandId: string;
    answer: Promise<ApplyClickAnswer | null>;
    outcomes: Promise<CommandOutcome>[];
  } {
    const group = new GroupApply(crypto.randomUUID(), {
      saw: input.saw,
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
    const outcomes = input.members.map(({ ref, target, tree }) => {
      const member = group.member(ref.documentId);
      return joined(
        this.apply(ref, target, tree, input.saw, null, { commandId: group.commandId, ...member }),
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
            : this.captureOnReceipt(ref, { tree: true }, input.saw, {
                commandId: group.commandId,
                ...member,
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
   * Undo is the server's, by `commandId`. A created document is hidden at once and closes once the server
   * leaves review once the server answers, whether this Discard took it or an earlier one had;
   * any other stays in review, discarding, until then. An Apply that took it first, or a return,
   * shows on it. Server-only lifecycle commands share this account owner, never the Apply route.
   */
  async discardOnServer(
    ref: DraftRef,
    item: ThreadDraftListItem,
    commandId: string,
  ): Promise<CommandOutcome> {
    if (!this.active) return { kind: "blocked" };
    const own = this.generation(ref.itemKey);
    this.discardedHere.add(own);
    this.setState(
      ref.itemKey,
      item.isNew ? { hidden: true, failure: null } : { discarding: () => true, failure: null },
    );
    try {
      const result = await discardDraftItem(ref, {
        itemKey: item.itemKey,
        commandId,
        ends: "item",
      });
      if (!this.active) return { kind: "blocked" };
      const { outcome, untaken, lines } = discardAnswer(result, [ref.documentId]);
      const failure = leftOut(lines.get(ref.documentId));
      if (outcome.kind !== "returned" && !failure) {
        // An earlier Discard took it: it left review all the same, but not here.
        if (untaken.has(ref.documentId)) this.discardedHere.delete(own);
        // State held under the item key itself (no draft room ever bound, as for a picture)
        // would hide the document's next item in this branch too; the caller drops the row.
        const hides = item.isNew || this.generation(ref.itemKey) !== ref.itemKey;
        if (hides) this.endedAt.set(this.generation(ref.itemKey), Date.now());
        this.setState(
          ref.itemKey,
          hides ? { hidden: true, discarding: null } : { discarding: null },
        );
        if (item.isNew) this.lifecycle.closeCreated?.(ref);
        return outcome;
      }
      this.discardedHere.delete(own);
      this.setState(ref.itemKey, { hidden: false, discarding: null, failure });
      return outcome;
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
   * `tree` is the server's answer alone, which says what the command took. Null when the chosen
   * text couldn't be written: the move or delete stays with it.
   */
  discardItem(
    ref: DraftRef,
    item: ThreadDraftListItem,
    target: GroupsTarget | { kind: "tree" },
    history: Editor | "notice" | null,
    commandId: string,
  ): {
    handle: DiscardUndo | null;
    outcome: Promise<CommandOutcome>;
    tree: Promise<CommandOutcome>;
  } | null {
    if (!this.active || !item.tree) return null;
    const text =
      item.hasDraft && target.kind !== "tree" ? this.discard(ref, target, history) : null;
    if (item.hasDraft && target.kind !== "tree" && !text) return null;
    const tree = this.discardTree(ref, item, commandId);
    return {
      handle: text?.handle ?? null,
      tree,
      outcome: Promise.all([tree, text?.outcome]).then(([answer, discarded]) =>
        answer.kind === "done" && discarded ? discarded : answer,
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
        itemKey: item.itemKey,
        commandId,
        ends: "tree",
      });
      if (!this.active) return { kind: "blocked" };
      const { outcome, lines } = discardAnswer(result, [ref.documentId]);
      if (outcome.kind !== "done")
        this.setState(ref.itemKey, { failure: leftOut(lines.get(ref.documentId)) });
      return outcome;
    } catch {
      if (this.active) this.setState(ref.itemKey, { failure: { code: "discard-unknown" } });
      return { kind: "change-refused", code: "unknown" };
    }
  }
  /**
   * The branch's Discard on the server, as `commandId`, which its Undo names: every change of the
   * branch (`all`, the one command that closes it), or exactly the selected nodes, documents and
   * folders, each ending as its `ends` says. What it takes hides until the answer; an item an
   * Apply took first shows that on its own row, and a return or an unknown delivery on each.
   */
  async discardBranch(input: {
    projectId: string;
    branchId: string;
    commandId: string;
    selection:
      | { all: true; refs: readonly DraftRef[] }
      | {
          items: readonly { ref: DraftRef; ends: "tree" | "item" }[];
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
        for (const ref of scope.values()) this.setState(ref.itemKey, { hidden: false, failure });
    };
    try {
      const answer = await discardBranch(projectId, branchId, {
        commandId,
        ...("all" in selection
          ? { all: true as const }
          : {
              items: selection.items.map(({ ref, ends }) => ({ node: ref.documentId, ends })),
            }),
      });
      const { outcome, untaken, lines } = discardAnswer(
        answer,
        [...scope.values()].map((ref) => ref.documentId),
      );
      if (outcome.kind === "returned") {
        failed(null);
        return outcome;
      }
      // The caller drops the rows that left review, as an item's server Discard does: the keys
      // stay live, since the Discard's Undo reopens the same items, even a closed branch's. An
      // item an Apply took first keeps its row, with its own line.
      for (const ref of scope.values()) {
        if (untaken.has(ref.documentId)) this.discardedHere.delete(this.generation(ref.itemKey));
        this.setState(ref.itemKey, {
          hidden: false,
          failure: leftOut(lines.get(ref.documentId)),
        });
      }
      return outcome;
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
