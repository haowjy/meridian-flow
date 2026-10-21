/** Account-lifetime command ownership. Surfaces share one frozen FIFO and one optimistic base per draft. */
import {
  APPLY_RECORD_ROOT,
  applyBase,
  applySpanPatches,
  baseViewDelta,
  blocksEqual,
  composeGroups,
  readApplyRecord,
  recordRestorations,
  writeDiscardBlocks,
} from "@meridian/agent-edit/diff";
import type { ApplyClick, ThreadDraftListItem } from "@meridian/contracts/branches";
import { draftRoomName, parseYjsRoomName } from "@meridian/contracts/protocol";
import type { Node as PMNode } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
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
import { ApplyClickQueue } from "./apply-click-queue";
import type { BranchCommandFailure, DraftRef } from "./review-command-types";
import { readBase } from "./review-frame";
import type { ChangeTarget, ReviewChange } from "./review-model";
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
  | { kind: "done" }
  | { kind: "change-refused"; code: string };
type Binding = {
  session: DocumentSession;
  runtime: ReviewRuntime;
  notices: Set<() => void>;
  stop(): void;
};
type Entry = {
  ref: DraftRef;
  binding: Binding | null;
  queue: ApplyClickQueue;
  users: number;
  lease: DraftRoomRead | null;
  unwatchLease(): void;
};
export type DiscardNotice = {
  itemKey?: string;
  kind: "discarded" | "removed";
  undo?: () => Promise<void>;
  end(): void;
};
const EDITOR_DISCARD_ORIGIN = Symbol("editor-draft-discard");
const histories = new WeakSet<Y.UndoManager>();
function installRestorations(history: Y.UndoManager) {
  if (!histories.has(history)) {
    histories.add(history);
    recordRestorations(history);
  }
}
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

export class DraftCommandOwner {
  private readonly reveals = new Map<string, ApplyClickQueue>();
  private readonly entries = new Map<string, Entry>();
  private readonly byItem = new Map<string, Entry>();
  private readonly identities = new Map<string, string>();
  private readonly records = new Map<string, DraftCommandState>();
  private readonly listeners = new Set<() => void>();
  private readonly closingWorks = new Set<string>();
  private readonly resolvingGone = new Map<string, Promise<void>>();
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
  state(itemKey: string): DraftCommandState {
    return this.records.get(this.identities.get(itemKey) ?? itemKey) ?? EMPTY;
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
    const previousId = this.identities.get(ref.itemKey);
    this.identities.set(ref.itemKey, address.draftId);
    if (previousId !== address.draftId) this.publish();
    let entry = this.entries.get(address.draftId);
    if (!entry) {
      const owned: Entry = {
        ref,
        binding: null,
        users: 0,
        lease: null,
        unwatchLease: () => {},
        queue: new ApplyClickQueue({
          send: (body) => applyDraftClick(ref, body),
          lookup: (body) => observeDraftClick(ref, body),
          changed: () => {
            const binding = owned.binding;
            binding?.runtime.invalidateBase();
            const pending = owned.queue.clicks.length > 0;
            this.setState(
              ref.itemKey,
              {
                pending,
                applying: owned.queue.applying,
                stalled: owned.queue.clicks[0]?.stalled ?? false,
              },
              address.draftId,
            );
            if (pending && !owned.lease) {
              const lease = readDraftRoom(this.registry, session.roomKey);
              owned.lease = lease;
              const follow = () => {
                const next = lease.usable();
                if (next) this.attach(owned, next);
              };
              owned.unwatchLease = lease.subscribe(follow);
              follow();
            }
            if (!pending && owned.lease) {
              owned.unwatchLease();
              owned.lease.dispose();
              owned.lease = null;
            }
            this.releaseIdle(address.draftId, owned);
          },
          refused: (answer) =>
            this.setState(
              ref.itemKey,
              {
                failure: {
                  code: "apply-refused",
                  serverCode: answer.status === "refused" ? answer.reason : "gone",
                  removal: answer.status === "closed" ? answer.removal : undefined,
                },
              },
              address.draftId,
            ),
        }),
      };
      entry = owned;
      this.entries.set(address.draftId, owned);
      this.byItem.set(ref.itemKey, owned);
    }
    const held = entry;
    held.users++;
    this.attach(held, session);
    return () => {
      held.users--;
      this.releaseIdle(address.draftId, held);
    };
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
      for (const click of entry.queue.clicks)
        if (!recorded.has(click.body.commandId))
          base = applyBase(schema, base, click.optimistic, click.patched);
      return base;
    });
    const record = session.document.getArray(APPLY_RECORD_ROOT);
    const observe = () => {
      binding.runtime.invalidateBase();
      entry.queue.observe(
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
        this.finishClose(entry.ref, connection.disposition);
      } else if (
        snapshot.status === "destroyed" ||
        connection?.kind === "reset" ||
        connection?.kind === "terminal" ||
        connection?.kind === "unauthorized"
      ) {
        this.detach(entry);
        entry.queue.refuseUnsent();
      }
    });
    // subscribe publishes synchronously, including an already retired session.
    if (entry.binding !== binding) stopSession();
    else observe();
  }

  /** Only the typed metadata `gone` answer enters here, never a failed read or list omission. */
  metadataGone(ref: DraftRef): Promise<void> {
    if (!this.active || this.state(ref.itemKey).closed) return Promise.resolve();
    const pending = this.resolvingGone.get(ref.itemKey);
    if (pending) return pending;
    const entry = this.byItem.get(ref.itemKey);
    const lease = entry?.binding
      ? readDraftRoom(this.registry, entry.binding.session.roomKey)
      : null;
    if (entry) entry.users++;
    this.setState(ref.itemKey, { checkingClose: true });
    const resolving = (async () => {
      const disposition = await this.lifecycle.resolveGone?.(ref);
      if (this.active && disposition)
        this.finishClose(ref, disposition.disposition, disposition.liveUri);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.resolvingGone.delete(ref.itemKey);
        if (this.active) this.setState(ref.itemKey, { checkingClose: false });
        lease?.dispose();
        const id = this.identities.get(ref.itemKey);
        if (entry) {
          entry.users--;
          if (id) this.releaseIdle(id, entry);
        }
      });
    this.resolvingGone.set(ref.itemKey, resolving);
    return resolving;
  }

  private finishClose(ref: DraftRef, disposition: "closed" | "removed", liveUri?: string) {
    if (!this.active || this.state(ref.itemKey).closed) return;
    const entry = this.byItem.get(ref.itemKey);
    const frame = entry?.binding?.runtime.projectNow();
    const unsentText =
      disposition === "closed" &&
      !this.state(ref.itemKey).hidden &&
      entry?.binding?.session.hasUnacknowledgedEdits()
        ? (frame?.doc.textBetween(0, frame.doc.content.size, "\n\n") ?? null)
        : null;
    if (disposition === "removed") this.lifecycle.removed?.(ref);
    this.setState(ref.itemKey, {
      closed: true,
      checkingClose: false,
      removed: disposition === "removed",
      unsentText,
      liveUri: liveUri ?? null,
    });
    if (entry?.binding) for (const end of entry.binding.notices) end();
    entry?.queue.close();
    const id = this.identities.get(ref.itemKey);
    if (id) void this.registry.closeDraftRoom(draftRoomName(id)).catch(() => undefined);
  }

  private releaseIdle(id: string, entry: Entry) {
    if (entry.users || entry.queue.clicks.length || this.entries.get(id) !== entry) return;
    this.detach(entry);
    this.entries.delete(id);
    if (this.byItem.get(entry.ref.itemKey) === entry) this.byItem.delete(entry.ref.itemKey);
  }

  reveal(ref: DraftRef): { sent: boolean; outcome: Promise<CommandOutcome> } {
    if (!this.active || this.reveals.has(ref.itemKey))
      return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
    const queue = new ApplyClickQueue({
      send: (body) => applyDraftClick(ref, body),
      lookup: (body) => observeDraftClick(ref, body),
      changed: () =>
        this.setState(ref.itemKey, {
          pending: queue.clicks.length > 0,
          applying: queue.applying,
          stalled: queue.clicks[0]?.stalled ?? false,
        }),
      refused: (answer) =>
        this.setState(ref.itemKey, {
          hidden: false,
          failure: {
            code: "apply-refused",
            serverCode: answer.status === "refused" ? answer.reason : "gone",
          },
        }),
    });
    this.reveals.set(ref.itemKey, queue);
    this.setState(ref.itemKey, { hidden: true, failure: null });
    const outcome = queue
      .enqueue({
        body: { commandId: crypto.randomUUID(), groupIds: [], baseViewDelta: [] },
        optimistic: [],
        patched: [],
        acknowledged: Promise.resolve(),
      })
      .then((answer): CommandOutcome => {
        this.reveals.delete(ref.itemKey);
        return answer.status === "applied"
          ? { kind: "done" }
          : { kind: "change-refused", code: answer.status === "refused" ? answer.reason : "gone" };
      });
    return { sent: true, outcome };
  }

  /** No await before snapshot, group validation, O, P and acknowledgement barrier are frozen. */
  apply(ref: DraftRef, target: ChangeTarget): { sent: boolean; outcome: Promise<CommandOutcome> } {
    const entry = this.byItem.get(ref.itemKey);
    const binding = entry?.binding;
    if (
      !this.active ||
      !entry ||
      !binding?.runtime.state().ready ||
      this.state(ref.itemKey).discarding
    )
      return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
    const frame = binding.runtime.projectNow();
    if (!frame) return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
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
      return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
    const schema = frame.doc.type.schema;
    const optimistic = frame.diff.base.blocks;
    const patched = applySpanPatches(
      optimistic,
      composeGroups(schema, frame, ids, "apply"),
      "base",
    );
    const body: ApplyClick = {
      commandId: crypto.randomUUID(),
      draftId: this.identities.get(ref.itemKey),
      snapshot: base64(Y.encodeSnapshotV2(Y.snapshot(binding.session.document))),
      groupIds: [...ids],
      baseViewDelta: baseViewDelta(
        schema,
        readBase(binding.session.document, schema),
        optimistic,
      ).map((patch) => ({ ...patch, blocks: patch.blocks.map((block) => block.toJSON()) })),
    };
    this.setState(ref.itemKey, { failure: null });
    const result = entry.queue.enqueue({
      body,
      optimistic,
      patched,
      acknowledged: binding.session.whenCurrentChangesAcknowledged(),
    });
    binding.runtime.projectNow();
    return {
      sent: true,
      outcome: result.then((answer) =>
        answer.status === "applied"
          ? { kind: "done" }
          : answer.status === "cancelled"
            ? { kind: "blocked" }
            : {
                kind: "change-refused",
                code: answer.status === "refused" ? answer.reason : "gone",
              },
      ),
    };
  }

  /** The caller selects history ownership, never whether an editor happens to be mounted. */
  discard(
    ref: DraftRef,
    target: ChangeTarget,
    surface: "editor" | "dock",
    onNoticeEnd?: () => void,
  ): { notice: DiscardNotice; outcome: Promise<CommandOutcome> } | null {
    const entry = this.byItem.get(ref.itemKey);
    const binding = entry?.binding;
    if (
      !this.active ||
      !entry ||
      !binding?.runtime.state().ready ||
      this.state(ref.itemKey).discarding
    )
      return null;
    const frame =
      surface === "editor" ? binding.runtime.projectNow() : binding.runtime.state().frame;
    if (!frame) return null;
    if (
      target.kind === "groups" &&
      (!blocksEqual(frame.diff.base.blocks, target.frame.diff.base.blocks) ||
        !blocksEqual(frame.diff.draft.blocks, target.frame.diff.draft.blocks))
    ) {
      this.setState(ref.itemKey, {
        failure: { code: "discard-refused", serverCode: "review_updated" },
      });
      return null;
    }
    const ids = target.kind === "draft" ? frame.groups.map((group) => group.id) : target.groupIds;
    if (!ids.length || ids.some((id) => !frame.groups.some((group) => group.id === id)))
      return null;
    const editor = surface === "editor" ? binding.runtime.editor("editor") : null;
    if (surface === "editor" && !editor) return null;
    const doc = binding.session.document;
    const fragment = doc.getXmlFragment("prosemirror");
    const wholeClick = !editor && target.kind === "draft";
    const queued = wholeClick ? [...entry.queue.clicks] : [];
    let changed = false;
    const onTextChange = () => {
      changed = true;
    };
    // A whole click includes unprojected typing without scanning the document's history at the click.
    if (wholeClick) doc.on("update", onTextChange);
    if (!editor)
      for (const surface of ["editor", "dock"] as const) {
        const attached = binding.runtime.editor(surface);
        if (attached) yUndoPluginKey.getState(attached.state)?.undoManager.stopCapturing();
      }
    const origin = editor ? EDITOR_DISCARD_ORIGIN : {};
    const history: Y.UndoManager = editor
      ? yUndoPluginKey.getState(editor.state).undoManager
      : new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTimeout: 0 });
    // Direct writes are not binding repairs, but still belong in the chosen history.
    history.addTrackedOrigin(origin);
    installRestorations(history);
    history.stopCapturing();
    const write = (): CommandOutcome => {
      doc.off("update", onTextChange);
      if (!this.active || entry.binding !== binding || this.state(ref.itemKey).closed)
        return { kind: "blocked" };
      const current = binding.runtime.projectNow();
      // A paint opportunity is not a lock: never overwrite typing or a peer write that arrived meanwhile.
      if (
        !current ||
        (wholeClick
          ? changed ||
            queued.length !== entry.queue.clicks.length ||
            queued.some((click, index) => entry.queue.clicks[index] !== click)
          : !blocksEqual(frame.diff.base.blocks, current.diff.base.blocks) ||
            !blocksEqual(frame.diff.draft.blocks, current.diff.draft.blocks))
      ) {
        this.setState(ref.itemKey, {
          failure: { code: "discard-refused", serverCode: "review_updated" },
        });
        return { kind: "change-refused", code: "review_updated" };
      }
      const cut = wholeClick ? current : frame;
      const selected = wholeClick ? cut.groups.map((group) => group.id) : ids;
      const blocks = applySpanPatches(
        cut.diff.draft.blocks,
        composeGroups(cut.doc.type.schema, cut, selected, "discard"),
        "draft",
      );
      doc.transact(() => writeDiscardBlocks(fragment, cut.doc.type.schema, blocks), origin);
      history.stopCapturing();
      binding.runtime.projectNow();
      return { kind: "done" };
    };
    if (editor) {
      const outcome = write();
      return { notice: { kind: "discarded", end() {} }, outcome: Promise.resolve(outcome) };
    }
    const lease = readDraftRoom(this.registry, binding.session.roomKey);
    entry.users++;
    const id = parseYjsRoomName(binding.session.roomKey);
    let active = true;
    let pending = true;
    let settle!: (outcome: CommandOutcome) => void;
    const outcome = new Promise<CommandOutcome>((resolve) => {
      settle = resolve;
    });
    const finish = (answer: CommandOutcome) => {
      doc.off("update", onTextChange);
      this.setState(ref.itemKey, { discarding: null });
      settle(answer);
    };
    const commit = () => {
      if (!pending) return;
      pending = false;
      cancelAnimationFrame(paintFrame);
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        const answer = write();
        finish(answer);
        if (answer.kind !== "done") end();
      } catch {
        this.setState(ref.itemKey, { failure: { code: "discard-unknown" } });
        finish({ kind: "change-refused", code: "discard-unknown" });
        end();
      }
      release();
    };
    let released = false;
    const release = () => {
      if (pending || active || released) return;
      released = true;
      history.destroy();
      lease.dispose();
      entry.users--;
      if (id?.kind === "draft") this.releaseIdle(id.draftId, entry);
    };
    const end = () => {
      if (!active) return;
      active = false;
      binding.notices.delete(end);
      // Leaving ends Undo, not the accepted edit or its paint opportunity.
      release();
      onNoticeEnd?.();
    };
    binding.notices.add(end);
    this.setState(ref.itemKey, {
      discarding: (change) => change.frame?.diff === frame.diff && ids.includes(change.id),
      failure: null,
    });
    let paintFrame = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") commit();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // The notice is returned before React commits it. Allow that commit, then a
    // full paint opportunity before the indivisible write. Hidden pages drain directly.
    if (document.visibilityState === "hidden") setTimeout(commit, 0);
    else
      paintFrame = requestAnimationFrame(() => {
        paintFrame = requestAnimationFrame(() => {
          paintFrame = requestAnimationFrame(commit);
        });
      });
    return {
      outcome,
      notice: {
        kind: "discarded",
        itemKey: ref.itemKey,
        end,
        undo: () => {
          if (
            !active ||
            !this.active ||
            entry.binding !== binding ||
            this.state(ref.itemKey).closed
          ) {
            end();
            return Promise.resolve();
          }
          if (pending) {
            pending = false;
            cancelAnimationFrame(paintFrame);
            document.removeEventListener("visibilitychange", onVisibility);
            finish({ kind: "done" });
          } else {
            history.undo();
            binding.runtime.projectNow();
          }
          const acknowledged = binding.session.whenCurrentChangesAcknowledged();
          end();
          return acknowledged;
        },
      },
    };
  }

  retry(itemKey: string) {
    this.byItem.get(itemKey)?.queue.retry();
    this.reveals.get(itemKey)?.retry();
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
        failure: { code: "discard-refused", serverCode: result.status },
      });
      return { kind: "change-refused", code: result.status };
    } catch {
      settleOwn?.("kept");
      if (this.active)
        this.setState(ref.itemKey, { hidden: false, failure: { code: "discard-unknown" } });
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
    for (const queue of this.reveals.values()) queue.close();
    for (const entry of this.entries.values()) {
      entry.queue.close();
    }
  }
}
