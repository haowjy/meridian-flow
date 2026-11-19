/**
 * Account-lifetime command ownership. Each review item owns one frozen FIFO for its text, tree
 * and text+tree clicks; each draft room is a resource the item attaches, with its optimistic base.
 */
import { applyBase } from "@meridian/agent-edit/content-merge";
import {
  APPLY_RECORD_ROOT,
  applySpanPatches,
  baseViewDelta,
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
  DiscardCommandResult,
  TreeSaw,
} from "@meridian/contracts/branches";
import { draftRoomName, parseYjsRoomName } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import {
  applyDraftClick,
  applyItems,
  branchOf,
  discard as discardBranch,
  observeDraftClick,
  unapplyDraftClick,
} from "@/client/api/branches-api";
import type { DocumentSession } from "@/core/editor/document-session";
import {
  type DraftRoomRead,
  type DraftRoomRegistry,
  readDraftRoom,
} from "@/core/editor/draft-room-read";
import { readRoomOnce } from "@/core/editor/room-read-once";
import {
  type ApplyClickOutcome,
  ApplyClickQueue,
  type ApplyCommandHandle,
  type FrozenApply,
  frozenOn,
} from "./apply-click-queue";
import { ApplyEntries, type Histories, queuePort, serverPort } from "./apply-history";
import { DiscardRestores } from "./discard-restores";
import {
  type ApplyHalves,
  type DiscardTook,
  DraftNotices,
  halvesOf,
  itemOf,
} from "./draft-notices";
import { GroupApply } from "./group-apply";
import type { BranchCommandFailure, DraftRef } from "./review-command-types";
import {
  buildFrame,
  inSchema,
  type ReviewFrame,
  readBase,
  readChosen,
  roomContent,
} from "./review-frame";
import type { ApplyTarget, GroupsTarget, ReviewChange, TextTarget } from "./review-model";
import { type ReviewRuntime, retainReviewRuntime } from "./review-runtime";

export type DraftCommandState = {
  applying: boolean;
  unapplying: boolean;
  stalled: boolean;
  pending: boolean;
  hidden: boolean;
  discarding: ((change: ReviewChange) => boolean) | null;
  failure: BranchCommandFailure | null;
  /** The draft is gone for good: its Work or document was purged. The page leaves. */
  ended: boolean;
  checkingClose: boolean;
};
const EMPTY: DraftCommandState = {
  applying: false,
  unapplying: false,
  stalled: false,
  pending: false,
  hidden: false,
  discarding: null,
  failure: null,
  ended: false,
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
      /** Per-item facts committed by this click. */
      applied?: {
        itemKey: string;
        transition?: { from: string | null; to: string | null };
      }[];
      /** A Discard's answer: what of what it was sent it took (`DiscardTook`). */
      took?: DiscardTook;
    }
  /** The server answered for this item and landed neither half. */
  | { kind: "settled"; took?: DiscardTook }
  /** A closed owner answered and changed nothing; nothing is said, its drafts stay as they are. */
  | { kind: "returned" }
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
  /**
   * The room that ended, kept for its projection only: it folds the clicks the server applied
   * without a record (`ApplyClickQueue.landedUnrecorded`) until a room opens again.
   */
  ended: Binding | null;
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
/** `band`: a band's Apply, the one owner of its Undo in the band's editors. */
export type StartedApply = {
  sent: boolean;
  outcome: Promise<CommandOutcome>;
  band?: ApplyEntries;
};
/** A band's Apply: the editors its Ctrl+Z goes in. */
export type BandHistories = { histories: Histories };
/**
 * A Discard's answer for the documents it was sent. `done` when it took something, `settled` when
 * each item was settled before it, `returned` when a closed owner changed nothing. `untaken`: the
 * items it found settled (an earlier Discard's, or an Apply that took them first), which say
 * nothing. `already` is quiet and gives none.
 */
function discardAnswer(
  result: DiscardCommandResult,
  documentIds: readonly string[],
): { outcome: CommandOutcome; untaken: ReadonlySet<string> } {
  if (result.settled?.some((one) => one.rule === "returned"))
    return { outcome: { kind: "returned" }, untaken: new Set() };
  const untaken = new Set<string>();
  for (const one of result.settled ?? []) {
    if (one.rule !== "already" && one.rule !== "overtaken") continue;
    for (const item of one.item ? [one.item] : documentIds) untaken.add(item);
  }
  const took = { untaken: [...untaken] };
  return {
    outcome: documentIds.some((id) => !untaken.has(id))
      ? { kind: "done", took }
      : { kind: "settled", took },
    untaken,
  };
}
/** A Discard's showing in the review: every change, or the ones it names. */
const discardingOf = (text: "all" | readonly string[]) =>
  text === "all" ? () => true : (change: ReviewChange) => text.includes(change.id);
/** How long a Discard's showing waits for the server's write to reach the room. */
const ROOM_WRITE_WAIT_MS = 5_000;
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

const RESOLVE_RETRY_MS = 1_000;
const RESOLVE_RETRY_MAX_MS = 30_000;

export class DraftCommandOwner {
  private readonly items = new Map<string, Item>();
  private readonly entries = new Map<string, Entry>();
  /**
   * Band Applies in force or taken back, while their Ctrl+Z or Redo can run: their draft, and the
   * item queue's handle until the review lets go of the draft's room.
   */
  private readonly bandApplies = new Map<
    ApplyEntries,
    { draftId: string; handle: ApplyCommandHandle | null }
  >();
  /** Every Apply this tab can still take back or apply again, a band's or not. */
  readonly applied = new Set<ApplyEntries>();
  private readonly byItem = new Map<string, Entry>();
  private readonly identities = new Map<string, string>();
  private readonly records = new Map<string, DraftCommandState>();
  private readonly listeners = new Set<() => void>();
  private readonly closingBranches = new Set<string>();
  private readonly resolvingGone = new Map<string, Promise<void>>();
  private active = true;
  private revision = 0;
  /** Each Discard's restore, whatever sent it: the one progress every view reads. */
  readonly restores = new DiscardRestores();
  /** One notice per draft owner, outliving the surface that made it. */
  readonly notices = new DraftNotices(this.restores);
  constructor(
    private readonly registry: DraftRoomRegistry & {
      closeDraftRoom(roomKey: string, cause: "closed" | "removed"): Promise<void>;
      observeHistories(observer: () => void): () => void;
    },
    private readonly lifecycle: {
      /**
       * Whether a draft whose room closed or whose metadata answered gone is gone for good, read
       * from the server now: `open` when the server holds it, null when it can't tell yet; a
       * rejection is a failed read. Neither decides an end.
       */
      resolveEnd?(ref: DraftRef, draftId: string): Promise<"open" | "gone" | null>;
      closeCreated?(ref: DraftRef): void;
    } = {},
  ) {
    this.stopRejoining = registry.observeHistories(() => {
      for (const applied of this.applied) applied.enter();
    });
  }
  /** An Apply made before a session of its documents opened joins that session's history. */
  private readonly stopRejoining: () => void;
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
   * the same key. Each generation's record stays its own; only `bind`
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
        ended: null,
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
        redo: (body) => applyItems(ref.projectId, branchOf(ref.itemKey), body),
        changed: () => {
          for (const entry of item.rooms) {
            entry.binding?.runtime.invalidateBase();
            entry.ended?.runtime.invalidateBase();
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
    });
  }

  /** The clicks a draft's room records and its optimistic base folds, in FIFO order. */
  private textClicks(entry: Entry) {
    return entry.item.queue.clicks.filter((click) => frozenOn(click, entry.draftId));
  }

  /** A draft with clicks outstanding keeps its room read, surface or not, to observe their record. */
  private holdRoom(entry: Entry) {
    // A click whose room ended settles on its answer: no room needs opening to see its record.
    const pending =
      this.textClicks(entry).some((click) => !click.roomEnded) ||
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
    const { binding, ended } = entry;
    entry.binding = null;
    entry.ended = null;
    binding?.stop();
    ended?.stop();
  }

  private attach(entry: Entry, session: DocumentSession) {
    if (entry.binding?.session === session || entry.ended?.session === session) return;
    this.detach(entry);
    if (!session.isRoomEnded()) entry.item.queue.roomOpened(entry.draftId);
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
        // A headless room projects with a schema of its own each time: a click frozen on an earlier
        // one is read into this one, or no block would ever equal the base.
        (base, before, after) =>
          applyBase(schema, base, inSchema(schema, before), inSchema(schema, after)),
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
      } else if (session.isRoomEnded()) {
        entry.item.queue.roomEnded(entry.draftId);
        // It records nothing more, but its rows go on showing what the queue applies.
        entry.binding = null;
        entry.ended = binding;
      }
      // A released room is kept while it holds typing it can still send; this lets it go.
      this.releaseIdle(entry);
    });
    // subscribe publishes synchronously, including an already retired session.
    if (entry.binding !== binding) stopSession();
    else observe();
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
   * whichever order the close and a restore arrived.
   */
  private resolveEnd(ref: DraftRef, id: string): Promise<void> {
    if (!this.active || this.records.get(id)?.ended) return Promise.resolve();
    const pending = this.resolvingGone.get(id);
    if (pending) return pending;
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
        let end: "open" | "gone" | null | undefined;
        try {
          end = await this.lifecycle.resolveEnd?.(ref, id);
        } catch {
          end = null;
        }
        if (end === undefined || !this.active || this.records.get(id)?.ended) return;
        if (end === "gone") this.finishClose(ref, id);
        if (end) return;
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

  private finishClose(ref: DraftRef, id: string) {
    const record = this.records.get(id) ?? EMPTY;
    if (!this.active || record.ended) return;
    const entry = this.entries.get(id);
    this.setState(ref.itemKey, { ended: true, checkingClose: false }, id);
    if (entry?.binding) for (const stop of entry.binding.notices) stop();
    // The server refuses an Un-Apply against an ended draft: Ctrl+Z goes past its Applies.
    for (const [band, held] of this.bandApplies) if (held.draftId === id) band.end();
    // Only this draft's clicks: the item's tree clicks and a newer draft's go on.
    this.items.get(ref.itemKey)?.queue.close(id);
    if (id !== ref.itemKey)
      void this.registry.closeDraftRoom(draftRoomName(id), "closed").catch(reportError);
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
    for (const [band, held] of this.bandApplies) {
      if (held.draftId !== entry.draftId || !held.handle) continue;
      band.switchPort(
        serverPort({
          unapply: (body) => unapplyDraftClick(entry.ref, body),
          redo: (body) => applyItems(entry.ref.projectId, branchOf(entry.ref.itemKey), body),
        }),
      );
      held.handle = null;
    }
    this.releaseItem(entry.item);
  }

  private releaseItem(item: Item) {
    if (item.rooms.size || item.queue.pending || this.items.get(item.ref.itemKey) !== item) return;
    this.items.delete(item.ref.itemKey);
  }

  /** A click's answer, as its caller's outcome and a line on the generation it was made for. */
  private settled(ref: DraftRef, id: string, answer: ApplyClickOutcome): CommandOutcome {
    const outcome = this.outcomeOf(ref, answer);
    if (outcome.kind === "change-refused")
      this.setState(
        ref.itemKey,
        { failure: { code: "apply-refused", serverCode: outcome.code } },
        id,
      );
    return outcome;
  }

  /**
   * One item's outcome from its entry in the answer: done when either half landed (it gets the
   * Undo step and the applied facts), settled when neither did. What stayed out says nothing.
   */
  private outcomeOf(ref: DraftRef, answer: ApplyClickOutcome): CommandOutcome {
    if (answer.status === "applied") {
      const item = itemOf(answer, ref.documentId);
      const tree = item?.tree?.landed === true;
      if (!tree && item?.text?.landed !== true) return { kind: "settled" };
      const treeWhole = tree && !item?.tree?.settled?.some((one) => one.rule === "left_out");
      const branchId = parseDraftItemKey(ref.itemKey)?.branchId;
      return {
        kind: "done",
        commandId: answer.commandId,
        halves: halvesOf(answer),
        treeWhole,
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
    target: ApplyTarget,
    /**
     * Whether the click includes the item's tree records, its move, delete or creation: the
     * tree line, a whole-item Apply, or text groups chosen with the tree line.
     */
    requested: boolean,
    saw: TreeSaw | undefined,
    /** A band's Apply: the histories its Ctrl+Z goes in. */
    histories?: BandHistories | null,
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
    if (target.kind === "groups" && !room) return this.captureEnded(ref, target, tree, saw, joint);
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
    histories?: BandHistories | null,
    joint?: Joint,
  ): StartedApply | null {
    const entry = this.byItem.get(ref.itemKey);
    const binding = entry?.binding;
    if (!entry || !binding?.runtime.state().ready || this.records.get(entry.draftId)?.ended)
      return null;
    const frame = binding.runtime.projectNow();
    if (!frame) return null;
    // The room may have moved since the writer chose (Live typing reaching the base): name the
    // chosen changes as this frame does, and keep in the draft any it has no name for.
    const chosen =
      target.kind === "draft"
        ? { going: frame.groups.map((group) => ({ read: group.id })), stayed: [] }
        : readChosen(target.frame, frame, target.groupIds);
    const ids = chosen.going.map((pair) => pair.read);
    if (!ids.length) return null;
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
    const rebuilt = this.rebuilder(
      entry.draftId,
      target.kind === "draft" ? null : ids,
      frame,
      body,
    );
    const frozen: FrozenApply = {
      body,
      optimistic,
      patched,
      acknowledged,
      rebuild: rebuilt.rebuild,
      ...(joint ? { send: joint.send } : {}),
    };
    const scheduled = histories
      ? entry.item.queue.enqueueHistory({
          frozen,
          patchFor: (groupIds) =>
            applySpanPatches(optimistic, composeGroups(schema, frame, groupIds, "apply"), "base"),
          intent: () => this.setState(entry.ref.itemKey, { failure: null }),
          replayed: (answer) => void this.settled(entry.ref, entry.draftId, answer),
        })
      : { outcome: entry.item.queue.enqueue(frozen), handle: null };
    let band: ApplyEntries | undefined;
    if (scheduled.handle && histories) {
      const handle = scheduled.handle;
      const applied: ApplyEntries = new ApplyEntries(
        handle.applyInForce(),
        queuePort(handle, ref.documentId),
        histories.histories,
        null,
        () => {
          this.bandApplies.delete(applied);
          this.applied.delete(applied);
        },
      );
      band = applied;
      this.bandApplies.set(band, { draftId: entry.draftId, handle });
      this.applied.add(band);
    }
    binding.runtime.projectNow();
    return {
      sent: true,
      outcome: this.textOutcome(ref, entry.draftId, scheduled.outcome, rebuilt, joint),
      ...(band ? { band } : {}),
    };
  }

  /**
   * Some changes chosen on a frame whose room has ended (or isn't open yet): the click is built
   * from the draft as the server holds it when it is sent (`rebuilder`).
   */
  private captureEnded(
    ref: DraftRef,
    target: GroupsTarget,
    tree: boolean,
    saw: TreeSaw | undefined,
    joint?: Joint,
  ): StartedApply | null {
    const draftId = this.identities.get(ref.itemKey);
    if (!draftId || this.records.get(draftId)?.ended) return null;
    const { frame, groupIds } = target;
    // The frame's own cut: what the rows fold while it is rebuilt, and what goes when the room
    // can't be read (closed, access ended), so the server says why.
    const body: ApplyClick = {
      commandId: joint?.commandId ?? crypto.randomUUID(),
      draftId,
      snapshot: base64(Y.encodeSnapshotV2(frame.snapshot)),
      groupIds: [...groupIds],
      baseViewDelta: [],
      ...(tree ? { tree: true as const } : {}),
      ...(saw ? { saw } : {}),
    };
    const rebuilt = this.rebuilder(draftId, groupIds, frame, body);
    const schema = frame.doc.type.schema;
    const optimistic = frame.diff.base.blocks;
    this.setState(ref.itemKey, { failure: null });
    const outcome = this.item(ref).queue.enqueue({
      body,
      optimistic,
      patched: applySpanPatches(
        optimistic,
        composeGroups(schema, frame, groupIds, "apply"),
        "base",
      ),
      acknowledged: Promise.resolve(),
      madeAfterRoomEnded: true,
      rebuild: rebuilt.rebuild,
      ...(joint ? { send: joint.send } : {}),
    });
    return {
      sent: true,
      outcome: this.textOutcome(ref, draftId, outcome, rebuilt, joint),
    };
  }

  /**
   * A text click again, for a room that ended before the server had its typing: the whole draft
   * as the server's whole cut, else the chosen changes as a frozen click on the draft read from the
   * server now. A choice is never widened: a chosen change goes only when the server's read names
   * the same change (`readChosen`); any other stays in the draft.
   * `chosen` null: the whole draft; `shown` the frame it was chosen on, where the rows fold what
   * it applies (the read's own blocks are another schema's). A room that
   * can't be read sends the click as it was frozen, and the server says why; one this build can't
   * read settles unsent without a send, `needsReload`, since only a reload of this tab could read it.
   */
  private rebuilder(
    draftId: string,
    chosen: readonly string[] | null,
    shown: ReviewFrame,
    body: ApplyClick,
  ): { rebuild: NonNullable<FrozenApply["rebuild"]>; needsReload: boolean } {
    const result = {
      needsReload: false,
      rebuild: async (signal: AbortSignal) => {
        const fields = {
          commandId: body.commandId,
          draftId,
          ...(body.tree ? { tree: true as const } : {}),
          ...(body.saw ? { saw: body.saw } : {}),
        };
        if (!chosen)
          return {
            body: { ...fields, whole: true as const, groupIds: [], baseViewDelta: [] },
            optimistic: [],
            patched: [],
          };
        const fresh = await readRoomOnce(draftRoomName(draftId), signal);
        if (fresh === "schema") {
          result.needsReload = true;
          return "reload" as const;
        }
        if (!(fresh instanceof Y.Doc)) return undefined;
        try {
          const content = roomContent(fresh);
          const schema = content.doc.type.schema;
          const base = readBase(fresh, schema);
          const frame = buildFrame(fresh, base, content.doc);
          const { going } = readChosen(shown, frame, chosen);
          if (!going.length) return null;
          return {
            body: {
              ...fields,
              snapshot: base64(Y.encodeSnapshotV2(frame.snapshot)),
              groupIds: going.map((pair) => pair.read),
              baseViewDelta: [],
            },
            optimistic: shown.diff.base.blocks,
            patched: applySpanPatches(
              shown.diff.base.blocks,
              composeGroups(
                shown.doc.type.schema,
                shown,
                going.map((pair) => pair.shown),
                "apply",
              ),
              "base",
            ),
          };
        } finally {
          fresh.destroy();
        }
      },
    };
    return result;
  }

  /** A text click's outcome, with the changes a rebuild left in the draft said on its item. */
  private textOutcome(
    ref: DraftRef,
    draftId: string,
    outcome: Promise<ApplyClickOutcome>,
    rebuilt: { needsReload: boolean },
    joint?: Joint,
  ): Promise<CommandOutcome> {
    return outcome.then((answer) => {
      joint?.answered(answer);
      const settled = this.settled(ref, draftId, answer);
      // The server can't take a click from this build until the tab reloads: say that, not "try again".
      if (rebuilt.needsReload)
        this.setState(
          ref.itemKey,
          { failure: { code: "apply-refused", serverCode: "needs_reload" } },
          draftId,
        );
      return settled;
    });
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
      target: ApplyTarget;
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

  retry(itemKey: string) {
    if (this.items.get(itemKey)?.queue.stalled) this.setState(itemKey, { failure: null });
    this.items.get(itemKey)?.queue.retry();
  }
  /**
   * The one Discard, a server command named by `commandId`, which its Undo names too: every change
   * of the branch (`all`), or exactly the chosen items, each with what is taken from it. The
   * writer sees it at once: a document's changes show as discarded in the review (`discarding`)
   * until the server's write reaches the room, and a document or folder taken whole is hidden until
   * the answer. An item an Apply took first shows that on its own row, and a return or an unknown
   * delivery on each.
   */
  async discard(input: {
    projectId: string;
    branchId: string;
    commandId: string;
    selection:
      | { all: true; refs: readonly DraftRef[] }
      | {
          items: readonly {
            ref: DraftRef;
            tree: boolean;
            /** The text changes taken: all of them, those named, or none. */
            text: "all" | readonly string[] | null;
            /** Gone whole at once, as a created document or a folder is, rather than shown discarded. */
            hides: boolean;
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
    // A Discard all in flight takes everything: nothing else is sent on the branch until it answers.
    if ("all" in selection) this.closingBranches.add(branchId);
    const shown = new Map<string, "all" | readonly string[]>();
    for (const ref of scope.values()) {
      const taken =
        "all" in selection
          ? null
          : selection.items.find((item) => item.ref.itemKey === ref.itemKey);
      if ("all" in selection || taken?.hides) {
        this.setState(ref.itemKey, { hidden: true, failure: null });
      } else if (taken?.text) {
        shown.set(ref.itemKey, taken.text);
        this.setState(ref.itemKey, { discarding: discardingOf(taken.text), failure: null });
      }
    }
    const failed = (failure: BranchCommandFailure | null) => {
      if (this.active)
        for (const ref of scope.values())
          this.setState(ref.itemKey, { hidden: false, discarding: null, failure });
    };
    try {
      const answer = await discardBranch(projectId, branchId, {
        commandId,
        ...("all" in selection
          ? { all: true as const }
          : {
              items: selection.items.map(({ ref, tree, text }) => ({
                node: ref.documentId,
                ...(tree ? { tree: true as const } : {}),
                ...(text ? { text: text === "all" ? text : [...text] } : {}),
              })),
            }),
      });
      const { outcome } = discardAnswer(
        answer,
        [...scope.values()].map((ref) => ref.documentId),
      );
      if (outcome.kind === "returned") {
        failed(null);
        return outcome;
      }
      // The caller drops the rows that left review.
      for (const ref of scope.values()) {
        this.setState(ref.itemKey, { hidden: false, failure: null });
        const text = shown.get(ref.itemKey);
        if (text) this.releaseWhenRoomHas(ref.itemKey, text);
      }
      return outcome;
    } catch {
      failed(null);
      return { kind: "change-refused", code: "unknown" };
    } finally {
      if ("all" in selection) this.closingBranches.delete(branchId);
    }
  }

  /**
   * Ends the review's showing of a Discard once its write is in the room, so the change never
   * flashes back. A room that never gets it (offline) is not waited on past `ROOM_WRITE_WAIT_MS`.
   */
  private releaseWhenRoomHas(itemKey: string, text: "all" | readonly string[]) {
    const runtime = this.byItem.get(itemKey)?.binding?.runtime;
    const release = () => this.setState(itemKey, { discarding: null });
    if (!runtime?.state().ready) return release();
    const out = (changes: readonly ReviewChange[]) =>
      text === "all" ? changes.length === 0 : !changes.some((change) => text.includes(change.id));
    if (out(runtime.state().changes)) return release();
    const stop = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    const unsubscribe = runtime.subscribe(() => {
      if (!out(runtime.state().changes)) return;
      stop();
      release();
    });
    const timer = setTimeout(() => {
      stop();
      release();
    }, ROOM_WRITE_WAIT_MS);
  }
  close() {
    this.active = false;
    this.stopRejoining();
    this.notices.close();
    for (const item of this.items.values()) item.queue.close();
    // Their entries sit on sessions that outlive this owner.
    for (const applied of this.applied.values()) applied.end();
  }
}

/** A folder's item in a Work's branch: the key its commands' state is kept under. */
export const folderKey = (branchId: string, folderId: string): string =>
  draftItemKey(branchId as BranchId, folderId);
