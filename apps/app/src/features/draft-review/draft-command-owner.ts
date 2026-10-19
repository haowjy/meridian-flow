/** Account-lifetime command ownership. Surfaces share one frozen FIFO and one optimistic base per draft. */
import {
  APPLY_RECORD_ROOT,
  applyBase,
  applySpanPatches,
  baseViewDelta,
  blocksEqual,
  composeGroups,
  REVIEW_BASE_FRAGMENT,
  readApplyRecord,
  recordRestorations,
  writeDiscardBlocks,
} from "@meridian/agent-edit/diff";
import type { ApplyClick, ThreadDraftListItem } from "@meridian/contracts/branches";
import { draftRoomName, parseYjsRoomName } from "@meridian/contracts/protocol";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
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
import type { ChangeTarget } from "./review-model";
import { type ReviewRuntime, retainReviewRuntime } from "./review-runtime";

export type DraftCommandState = {
  applying: boolean;
  stalled: boolean;
  pending: boolean;
  hidden: boolean;
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
type Entry = {
  ref: DraftRef;
  session: DocumentSession;
  runtime: ReviewRuntime;
  queue: ApplyClickQueue;
  users: number;
  lease: DraftRoomRead | null;
  releaseRuntime(): void;
  stop(): void;
  cache: WeakMap<Schema, readonly PMNode[]>;
};
export type DiscardNotice = {
  itemKey?: string;
  kind: "discarded" | "removed";
  undo?: () => void;
  end(): void;
};
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
    this.records.set(id, { ...(this.records.get(id) ?? EMPTY), ...state });
    this.publish();
  }

  bind(ref: DraftRef, session: DocumentSession): () => void {
    const address = parseYjsRoomName(session.roomKey);
    if (address?.kind !== "draft") throw new Error("Commands require a draft room");
    this.identities.set(ref.itemKey, address.draftId);
    let entry = this.entries.get(address.draftId);
    if (entry && entry.session !== session)
      throw new Error("A draft cannot have two command rooms");
    if (!entry) {
      const hold = retainReviewRuntime(session);
      const invalidate = () => {
        if (!entry) return;
        entry.cache = new WeakMap();
        entry.runtime.invalidateBase();
      };
      const changed = () => {
        if (!entry) return;
        invalidate();
        const pending = entry.queue.clicks.length > 0;
        this.setState(
          ref.itemKey,
          {
            pending,
            applying: entry.queue.applying,
            stalled: entry.queue.clicks[0]?.stalled ?? false,
          },
          address.draftId,
        );
        if (pending && !entry.lease) entry.lease = readDraftRoom(this.registry, session.roomKey);
        if (!pending) {
          entry.lease?.dispose();
          entry.lease = null;
        }
        this.releaseIdle(address.draftId, entry);
      };
      entry = {
        ref,
        session,
        runtime: hold.runtime,
        users: 0,
        lease: null,
        releaseRuntime: hold.release,
        stop: () => {},
        cache: new WeakMap(),
        queue: new ApplyClickQueue({
          send: (body) => applyDraftClick(ref, body),
          lookup: (body) => observeDraftClick(ref, body),
          changed,
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
      const owned = entry;
      this.entries.set(address.draftId, owned);
      this.byItem.set(ref.itemKey, owned);
      owned.runtime.setBaseProvider((_room, schema) => {
        let cached = owned.cache.get(schema);
        if (!cached) {
          const recorded = new Set(
            readApplyRecord(session.document).map((record) => record.commandId),
          );
          cached = readBase(session.document, schema);
          for (const click of owned.queue.clicks)
            if (!recorded.has(click.body.commandId))
              cached = applyBase(schema, cached, click.optimistic, click.patched);
          owned.cache.set(schema, cached);
        }
        return cached;
      });
      const base = session.document.getXmlFragment(REVIEW_BASE_FRAGMENT);
      const record = session.document.getArray(APPLY_RECORD_ROOT);
      const observe = () => {
        invalidate();
        owned.queue.observe(
          readApplyRecord(session.document).flatMap((row) =>
            row.commandId ? [row.commandId] : [],
          ),
        );
      };
      base.observeDeep(invalidate);
      record.observeDeep(observe);
      const stopSession = session.subscribe((snapshot) => {
        const connection = snapshot.connectionState;
        if (connection?.kind === "reset" && connection.disposition === "refused") {
          this.setState(
            ref.itemKey,
            {
              failure: { code: "discard-refused", serverCode: "forbidden" },
            },
            address.draftId,
          );
          return;
        }
        if (
          connection?.kind === "reset" &&
          (connection.disposition === "closed" || connection.disposition === "removed")
        )
          this.finishClose(ref, connection.disposition);
      });
      owned.stop = () => {
        stopSession();
        base.unobserveDeep(invalidate);
        record.unobserveDeep(observe);
      };
    }
    const held = entry;
    held.users++;
    return () => {
      held.users--;
      this.releaseIdle(address.draftId, held);
    };
  }
  /** Only the typed metadata `gone` answer enters here, never a failed read or list omission. */
  metadataGone(ref: DraftRef): Promise<void> {
    if (!this.active || this.state(ref.itemKey).closed) return Promise.resolve();
    const pending = this.resolvingGone.get(ref.itemKey);
    if (pending) return pending;
    const entry = this.byItem.get(ref.itemKey);
    const lease = entry ? readDraftRoom(this.registry, entry.session.roomKey) : null;
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
    const frame = entry?.runtime.projectNow();
    const unsentText =
      disposition === "closed" &&
      !this.state(ref.itemKey).hidden &&
      entry?.session.hasUnacknowledgedEdits()
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
    entry?.queue.close();
    const id = this.identities.get(ref.itemKey);
    if (id) void this.registry.closeDraftRoom(draftRoomName(id)).catch(() => undefined);
  }

  private releaseIdle(id: string, entry: Entry) {
    if (entry.users || entry.queue.clicks.length || this.entries.get(id) !== entry) return;
    entry.stop();
    entry.releaseRuntime();
    this.entries.delete(id);
    if (this.byItem.get(entry.ref.itemKey) === entry) this.byItem.delete(entry.ref.itemKey);
  }
  canApply(itemKey: string): boolean {
    const state = this.byItem.get(itemKey)?.runtime.state();
    return Boolean(state?.ready && state.changes.length);
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
    if (!this.active || !entry?.runtime.state().ready)
      return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
    const frame = entry.runtime.projectNow();
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
      snapshot: base64(Y.encodeSnapshotV2(Y.snapshot(entry.session.document))),
      groupIds: [...ids],
      baseViewDelta: baseViewDelta(
        schema,
        readBase(entry.session.document, schema),
        optimistic,
      ).map((patch) => ({ ...patch, blocks: patch.blocks.map((block) => block.toJSON()) })),
    };
    this.setState(ref.itemKey, { failure: null });
    const result = entry.queue.enqueue({
      body,
      optimistic,
      patched,
      acknowledged: entry.session.whenCurrentChangesAcknowledged(),
    });
    entry.runtime.projectNow();
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
  discard(ref: DraftRef, target: ChangeTarget, surface: "editor" | "dock"): DiscardNotice | null {
    const entry = this.byItem.get(ref.itemKey);
    if (!this.active || !entry?.runtime.state().ready) return null;
    const frame = entry.runtime.projectNow();
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
    const editor = surface === "editor" ? entry.runtime.editor("editor") : null;
    if (surface === "editor" && !editor) return null;
    const doc = entry.session.document;
    const fragment = doc.getXmlFragment("prosemirror");
    if (!editor)
      for (const surface of ["editor", "dock"] as const) {
        const attached = entry.runtime.editor(surface);
        if (attached) yUndoPluginKey.getState(attached.state)?.undoManager.stopCapturing();
      }
    const origin = editor ? ySyncPluginKey : {};
    const history: Y.UndoManager = editor
      ? yUndoPluginKey.getState(editor.state).undoManager
      : new Y.UndoManager(fragment, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    installRestorations(history);
    history.stopCapturing();
    const blocks = applySpanPatches(
      frame.diff.draft.blocks,
      composeGroups(frame.doc.type.schema, frame, ids, "discard"),
      "draft",
    );
    doc.transact(() => writeDiscardBlocks(fragment, frame.doc.type.schema, blocks), origin);
    history.stopCapturing();
    entry.runtime.projectNow();
    if (editor) return { kind: "discarded", end() {} };
    const lease = readDraftRoom(this.registry, entry.session.roomKey);
    entry.users++;
    const id = parseYjsRoomName(entry.session.roomKey);
    let active = true;
    const end = () => {
      if (!active) return;
      active = false;
      history.destroy();
      lease.dispose();
      entry.users--;
      if (id?.kind === "draft") this.releaseIdle(id.draftId, entry);
    };
    return {
      kind: "discarded",
      itemKey: ref.itemKey,
      end,
      undo: () => {
        if (!active || !this.active || this.state(ref.itemKey).closed) {
          end();
          return;
        }
        history.undo();
        entry.runtime.projectNow();
        end();
      },
    };
  }

  acknowledged(itemKey: string): Promise<void> {
    return this.byItem.get(itemKey)?.session.whenCurrentChangesAcknowledged() ?? Promise.resolve();
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
