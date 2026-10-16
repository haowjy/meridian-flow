/** Tab-local authoring owner for pane continuity, journal hand-off, Edit and hand-backs. */
import { type HandBackCommand, type MessageDoc, prependMessageDoc } from "@meridian/thread-client";
import type { ComposerDraftChange, ComposerDraftSnapshot } from "@/components/app/composer";
import {
  parseRestorableComposerDraft,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { browserRecord, isRecord, type StorageSource } from "./storage/browser-record";

export type ComposerDraftScope = { kind: "chat" | "new-chat"; id: string };

export type DeletedChatCard = { threadId: string; title: string | null; count: number };

/**
 * A hand-back request the writer pressed whose answer has not been written to the composer: kept
 * with the draft so a reload re-posts the same body (the server replays its stored decision) and
 * the content still arrives exactly once. The package owns the shape: Stop's stored format, and
 * the x / Cancel queue's ids.
 */
export type PendingHandBack = HandBackCommand;

type StoredComposerDraft = (ComposerDraftSnapshot | { doc: null }) & {
  received?: string[];
  notices?: DeletedChatCard[];
  handBacks?: PendingHandBack[];
};

/** The `received` entry a hand-back leaves: the checked write that carries the content records it. */
export const handBackReceipt = (requestId: string) => `handBack:${requestId}`;

function isPendingHandBack(value: unknown): value is PendingHandBack {
  if (!isRecord(value) || typeof value.requestId !== "string") return false;
  if (value.kind === "queue")
    return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string");
  if (value.kind !== "stop") return false;
  const body = value.body;
  return (
    isRecord(body) &&
    body.requestId === value.requestId &&
    typeof body.seenThrough === "number" &&
    (body.seenExecutionId === null || typeof body.seenExecutionId === "string") &&
    Array.isArray(body.mine) &&
    body.mine.every((id) => typeof id === "string")
  );
}

export class ComposerSessionDraft {
  readonly key: string;
  private readonly record: ReturnType<typeof browserRecord<StoredComposerDraft>>;
  private current: ComposerDraftSnapshot | null;
  private received = new Set<string>();
  private handBacksPending: PendingHandBack[] = [];
  notices: DeletedChatCard[] = [];
  dismissNotice = (threadId: string) => {
    this.notices = this.notices.filter((notice) => notice.threadId !== threadId);
    this.dirty = true;
    this.flush();
    this.publish();
  };
  hasReceived = (recordId: string) => this.received.has(recordId);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private version = 0;
  private listeners = new Set<() => void>();
  getVersion = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** One ordered transfer for a rejected cohort, followed by this destination's newer writing. */
  prependSnapshots(
    snapshots: ComposerDraftSnapshot[],
    recordIds: string[] = [],
    notice?: DeletedChatCard,
  ): boolean {
    const pending = snapshots.filter(
      (_, index) => !recordIds[index] || !this.hasReceived(recordIds[index]),
    );
    if (!pending.length) return true;
    snapshots = pending;
    const first = snapshots[0];
    if (!first) return false;
    const all = [...snapshots];
    const typed =
      this.current && serializeComposerDraft(this.current.doc).text ? this.current : null;
    if (typed) all.push(typed);
    // The package's rule: each earlier message above the rest, one empty paragraph between.
    const doc = all.reduceRight<MessageDoc | null>(
      (below, snapshot) => prependMessageDoc(snapshot.doc as MessageDoc, below),
      null,
    ) as ComposerDraftSnapshot["doc"];
    const edited = {
      ...first,
      revision: Math.max(...all.map((snapshot) => snapshot.revision)) + 1,
      doc,
      ownedUploads: all.flatMap((snapshot) => snapshot.ownedUploads),
    };
    const received = new Set([...this.received, ...recordIds]);
    const notices = notice
      ? [...this.notices.filter((item) => item.threadId !== notice.threadId), notice]
      : this.notices;
    return this.commit(edited, { received, notices, handBacks: this.handBacksPending });
  }

  /** The hand-back requests this tab pressed and has not written to the composer. */
  get handBacks(): readonly PendingHandBack[] {
    return this.handBacksPending;
  }

  /** Whether a hand-back's content already went into this composer. */
  hasReceivedHandBack = (requestId: string) => this.received.has(handBackReceipt(requestId));

  /**
   * Keep a hand-back request with the draft before it is sent, so no press is lost to a reload.
   * False when the write failed: the caller must not send.
   */
  recordHandBack(command: PendingHandBack): boolean {
    if (this.handBacksPending.some((known) => known.requestId === command.requestId)) return true;
    return this.commit(this.current, {
      received: this.received,
      notices: this.notices,
      handBacks: [...this.handBacksPending, command],
    });
  }

  /** A request the server refused: nothing came back, so the command goes. */
  dropHandBack(requestId: string): boolean {
    if (!this.handBacksPending.some((known) => known.requestId === requestId)) return true;
    return this.commit(this.current, {
      received: this.received,
      notices: this.notices,
      handBacks: this.handBacksPending.filter((known) => known.requestId !== requestId),
    });
  }

  /**
   * A hand-back's content above what is typed, the receipt, and the command's retirement in one
   * checked write. A request already received prepends nothing (two answers for one request, or
   * a reload after the write). False when the write failed or the merged document wouldn't
   * restore after a reload: the command stays, and a retry of the same request brings the
   * content again. A document that can't restore never retires the command.
   */
  receiveHandBack(requestId: string, returned: MessageDoc): boolean {
    if (this.hasReceivedHandBack(requestId)) return this.dropHandBack(requestId);
    const typed =
      this.current && serializeComposerDraft(this.current.doc).text ? this.current : null;
    const doc = prependMessageDoc(
      returned,
      typed ? (typed.doc as MessageDoc) : null,
    ) as ComposerDraftSnapshot["doc"];
    const edited = {
      revision: (this.current?.revision ?? 0) + 1,
      selection: typed?.selection ?? { anchor: 1, head: 1 },
      ownedUploads: typed?.ownedUploads ?? [],
      doc,
    };
    if (!parseRestorableComposerDraft(edited)) return false;
    return this.commit(edited, {
      received: new Set([...this.received, handBackReceipt(requestId)]),
      notices: this.notices,
      handBacks: this.handBacksPending.filter((known) => known.requestId !== requestId),
    });
  }

  /** One checked write of the draft with its receipts, notices and pending commands. */
  private commit(
    draft: ComposerDraftSnapshot | null,
    next: {
      received: Set<string>;
      notices: DeletedChatCard[];
      handBacks: PendingHandBack[];
    },
  ): boolean {
    const stored: StoredComposerDraft = {
      ...(draft ?? { doc: null }),
      received: [...next.received],
      notices: next.notices,
      handBacks: next.handBacks,
    };
    if (!this.record.write(stored)) return false;
    this.notices = next.notices;
    this.received = next.received;
    this.handBacksPending = next.handBacks;
    this.current = draft;
    this.dirty = false;
    this.publish();
    return true;
  }

  /** Once recorded, only the exact unchanged authoring draft transfers to the journal. */
  handoffSubmitted = (snapshot: ComposerDraftSnapshot): void => {
    if (this.matches(snapshot)) this.handoff();
  };

  private matches(snapshot: ComposerDraftSnapshot): boolean {
    // Selection movement is not editing. Normalize both sides so storage parsing
    // and object property order cannot change a structured document's identity.
    return (
      this.current?.revision === snapshot.revision &&
      JSON.stringify(parseRestorableComposerDraft(this.current)?.doc) ===
        JSON.stringify(parseRestorableComposerDraft(snapshot)?.doc)
    );
  }

  constructor(accountId: string, scope: ComposerDraftScope, storage: StorageSource = "session") {
    this.key = `meridian:composer-draft:v1:${JSON.stringify([accountId, scope.kind, scope.id])}`;
    this.record = browserRecord<StoredComposerDraft>(
      storage,
      { key: this.key, version: 1, accountId, scope: JSON.stringify([scope.kind, scope.id]) },
      (value) => {
        if (!isRecord(value)) return undefined;
        const received = value.received === undefined ? [] : value.received;
        if (!Array.isArray(received) || !received.every((id) => typeof id === "string"))
          return undefined;
        const handBacks = value.handBacks === undefined ? [] : value.handBacks;
        if (!Array.isArray(handBacks) || !handBacks.every(isPendingHandBack)) return undefined;
        const draft = value.doc === null ? null : parseRestorableComposerDraft(value);
        const notices = value.notices ?? [];
        if (
          !Array.isArray(notices) ||
          !notices.every(
            (item) =>
              isRecord(item) &&
              typeof item.threadId === "string" &&
              (item.title === null || typeof item.title === "string") &&
              typeof item.count === "number" &&
              item.count > 0,
          )
        )
          return undefined;
        return value.doc !== null && !draft
          ? undefined
          : {
              ...(draft ?? { doc: null }),
              received,
              notices: notices as DeletedChatCard[],
              handBacks,
            };
      },
    );
    const saved = this.record.read();
    this.current = saved ? parseRestorableComposerDraft(saved) : null;
    this.received = new Set(saved?.received);
    this.notices = saved?.notices ?? [];
    this.handBacksPending = saved?.handBacks ?? [];
  }

  get initialDraft(): ComposerDraftSnapshot | null {
    return this.current && parseRestorableComposerDraft(this.current);
  }

  updateDraft = (change: ComposerDraftChange): void => {
    this.current = change.snapshot;
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    // An empty draft (Send or explicit deletion) must never resurrect on reload.
    if (!change.text) this.flush();
    else this.timer = setTimeout(this.flush, 250);
  };

  /** Call only after the submission journal has durably accepted ownership. */
  handoff = (): void => {
    this.current = null;
    this.notices = [];
    this.dirty = true;
    this.flush();
  };

  flush = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    const draft = this.current && parseRestorableComposerDraft(this.current);
    const saved =
      !draft || !serializeComposerDraft(draft.doc).text
        ? this.record.write(
            this.received.size || this.handBacksPending.length
              ? {
                  doc: null,
                  received: [...this.received],
                  notices: this.notices,
                  handBacks: this.handBacksPending,
                }
              : undefined,
          )
        : this.record.write({
            ...draft,
            received: [...this.received],
            notices: this.notices,
            handBacks: this.handBacksPending,
          });
    if (saved) this.dirty = false;
  };
}

const sessionDrafts = new Map<string, ComposerSessionDraft>();

export function composerSessionDraft(
  accountId: string,
  scope: ComposerDraftScope,
): ComposerSessionDraft {
  if (typeof window === "undefined") return new ComposerSessionDraft(accountId, scope);
  const key = JSON.stringify([accountId, scope.kind, scope.id]);
  let owner = sessionDrafts.get(key);
  if (!owner) {
    owner = new ComposerSessionDraft(accountId, scope);
    sessionDrafts.set(key, owner);
  }
  return owner;
}

/** Enumerate this tab's saved chat boxes, not another account's drafts. */
export function storedChatDraftIds(accountId: string): string[] {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (!key?.startsWith("meridian:composer-draft:v1:")) continue;
      const [owner, kind, id] = JSON.parse(key.slice("meridian:composer-draft:v1:".length));
      if (
        owner === accountId &&
        kind === "chat" &&
        typeof id === "string" &&
        composerSessionDraft(accountId, { kind: "chat", id }).initialDraft
      )
        ids.add(id);
    }
  } catch {
    /* Unreadable drafts do not authorize deletion. */
  }
  return [...ids];
}
