import { type HandBackCommand, type MessageDoc, prependMessageDoc } from "@meridian/thread-client";
import { browserRecord, isRecord, type StorageSource } from "@/client/storage/browser-record";
import type { ComposerDraftChange, ComposerDraftSnapshot } from "./composer-document";
import {
  composerDocEnd,
  parseRestorableComposerDraft,
  serializeComposerDraft,
} from "./composer-document";

export type ComposerDraftScope = { kind: "chat" | "new-chat" | "side-new-chat"; id: string };

export type DeletedChatCard = {
  threadId: string;
  title: string | null;
  count: number;
  own?: boolean;
};

export type PendingHandBack = HandBackCommand;

type StoredComposerDraft = (ComposerDraftSnapshot | { doc: null }) & {
  received?: string[];
  notices?: DeletedChatCard[];
  handBacks?: PendingHandBack[];
  chatId?: string;
  parked?: ParkedDraft[];
  about?: AttachedAbout;
  project?: string;
};

export type AttachedAbout = { documentId: string; label: string };

const isAttachedAbout = (value: unknown): value is AttachedAbout =>
  isRecord(value) && typeof value.documentId === "string" && typeof value.label === "string";

type ParkedDraft = { chatId: string; draft: ComposerDraftSnapshot };

const isParkedDraft = (value: unknown): value is ParkedDraft =>
  isRecord(value) &&
  typeof value.chatId === "string" &&
  parseRestorableComposerDraft(value.draft) !== null;

export const handBackReceipt = (requestId: string) => `handBack:${requestId}`;

function isPendingHandBack(value: unknown): value is PendingHandBack {
  if (!isRecord(value) || typeof value.requestId !== "string") return false;
  const occurrence = value.occurrence;
  if (
    !isRecord(occurrence) ||
    typeof occurrence.requestId !== "string" ||
    !Number.isSafeInteger(occurrence.attempt) ||
    Number(occurrence.attempt) < 1
  )
    return false;
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
  /**
   * The thread id a New chat will be created with. Uploads attached before Send belong to it, so
   * it is minted here, kept with the draft, and reused by Send. A sent draft mints the next one.
   */
  chatId: string;
  private readonly mintsChat: boolean;
  private parked: ParkedDraft[] = [];
  private attached: AttachedAbout | null = null;
  project: string | null = null;
  setProject = (project: string): void => {
    if (this.mintsChat || this.project === project) return;
    this.project = project;
    this.dirty = true;
    this.flush();
  };
  private chatField(): {
    chatId?: string;
    parked?: ParkedDraft[];
    about?: AttachedAbout;
    project?: string;
  } {
    if (!this.mintsChat) return this.project ? { project: this.project } : {};
    return {
      chatId: this.chatId,
      parked: this.parked,
      ...(this.attached ? { about: this.attached } : {}),
    };
  }

  attachedAbout = (): AttachedAbout | null => this.attached;

  setAttachedAbout = (about: AttachedAbout | null): void => {
    this.attached = about;
    this.dirty = true;
  };

  recoverCreation(
    chatId: string,
    snapshots: ComposerDraftSnapshot[],
    recordIds: string[] = [],
  ): boolean {
    if (!this.mintsChat) return false;
    if (snapshots.every((_, index) => recordIds[index] && this.hasReceived(recordIds[index])))
      return true;
    const recovered = snapshots.some((snapshot) => snapshot.ownedUploads.length > 0);
    const typed = this.typed();
    const park = recovered && typed !== null && typed.ownedUploads.length > 0;
    const before = { current: this.current, chatId: this.chatId, parked: this.parked };
    if (park && typed) {
      this.parked = [...this.parked, { chatId: this.chatId, draft: typed }];
      this.current = null;
    }
    if (recovered) this.chatId = chatId;
    if (this.prependSnapshots(snapshots, recordIds)) return true;
    Object.assign(this, before);
    return false;
  }
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
  private external: { seq: number; draft: ComposerDraftSnapshot | null } = { seq: 0, draft: null };
  private listeners = new Set<() => void>();
  getVersion = () => this.version;
  externalChange = () => this.external;
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

  prependSnapshots(
    snapshots: ComposerDraftSnapshot[],
    recordIds: string[] = [],
    notice?: DeletedChatCard,
  ): boolean {
    const pending = snapshots.filter(
      (_, index) => !recordIds[index] || !this.hasReceived(recordIds[index]),
    );
    if (!pending.length) return true;
    const edited = this.withReturned(pending);
    if (!edited) return false;
    const received = new Set([...this.received, ...recordIds]);
    const notices = notice
      ? [...this.notices.filter((item) => item.threadId !== notice.threadId), notice]
      : this.notices;
    return this.commit(edited, { received, notices, handBacks: this.handBacksPending });
  }

  withdraw(threadId: string, before: ComposerDraftSnapshot | null): void {
    this.commit(before, {
      received: this.received,
      notices: this.notices.filter((notice) => notice.threadId !== threadId),
      handBacks: this.handBacksPending,
    });
  }

  get handBacks(): readonly PendingHandBack[] {
    return this.handBacksPending;
  }

  hasReceivedHandBack = (requestId: string) => this.received.has(handBackReceipt(requestId));

  recordHandBack(command: PendingHandBack): boolean {
    const held = this.handBacksPending.some((known) => known.requestId === command.requestId);
    return this.commit(this.current, {
      received: this.received,
      notices: this.notices,
      handBacks: held
        ? this.handBacksPending.map((known) =>
            known.requestId === command.requestId ? command : known,
          )
        : [...this.handBacksPending, command],
    });
  }

  dropHandBack(requestId: string): boolean {
    if (!this.handBacksPending.some((known) => known.requestId === requestId)) return true;
    return this.commit(this.current, {
      received: this.received,
      notices: this.notices,
      handBacks: this.handBacksPending.filter((known) => known.requestId !== requestId),
    });
  }

  receiveHandBack(requestId: string, returned: MessageDoc): boolean {
    if (this.hasReceivedHandBack(requestId)) return this.dropHandBack(requestId);
    const edited = this.withReturned([sentWords(returned)]);
    if (!edited) return false;
    return this.commit(edited, {
      received: new Set([...this.received, handBackReceipt(requestId)]),
      notices: this.notices,
      handBacks: this.handBacksPending.filter((known) => known.requestId !== requestId),
    });
  }

  putBack(returned: MessageDoc): boolean {
    const edited = this.withReturned([sentWords(returned)]);
    if (!edited) return false;
    return this.commit(edited, {
      received: this.received,
      notices: this.notices,
      handBacks: this.handBacksPending,
    });
  }

  private typed(): ComposerDraftSnapshot | null {
    return this.current && serializeComposerDraft(this.current.doc).text ? this.current : null;
  }

  private withReturned(returned: readonly ComposerDraftSnapshot[]): ComposerDraftSnapshot | null {
    const typed = this.typed();
    const stack = (snapshots: readonly ComposerDraftSnapshot[]) =>
      snapshots.reduceRight<MessageDoc | null>(
        (below, snapshot) => prependMessageDoc(snapshot.doc as MessageDoc, below),
        null,
      ) as ComposerDraftSnapshot["doc"];
    const all = typed ? [...returned, typed] : returned;
    const edited: ComposerDraftSnapshot = {
      revision:
        Math.max(this.current?.revision ?? 0, ...all.map((snapshot) => snapshot.revision)) + 1,
      selection: { anchor: 1, head: 1 },
      ownedUploads: all.flatMap((snapshot) => snapshot.ownedUploads),
      doc: stack(all),
    };
    if (!parseRestorableComposerDraft(edited)) return null;
    const end = composerDocEnd(stack(returned));
    return { ...edited, selection: { anchor: end, head: end } };
  }

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
      ...this.chatField(),
    };
    if (!this.record.write(stored)) return false;
    this.notices = next.notices;
    this.received = next.received;
    this.handBacksPending = next.handBacks;
    if (draft !== this.current)
      this.external = {
        seq: this.external.seq + 1,
        draft: draft && parseRestorableComposerDraft(draft),
      };
    this.current = draft;
    this.dirty = false;
    this.publish();
    return true;
  }

  handoffCreated = (chatId: string): void => {
    if (this.chatId === chatId) this.handoff();
  };

  handoffSubmitted = (snapshot: ComposerDraftSnapshot): void => {
    if (this.holds(snapshot)) this.handoff();
  };

  holds(snapshot: ComposerDraftSnapshot | null): boolean {
    if (!snapshot) return false;
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
              item.count > 0 &&
              (item.own === undefined || typeof item.own === "boolean"),
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
              ...(typeof value.chatId === "string" ? { chatId: value.chatId } : {}),
              ...(Array.isArray(value.parked)
                ? { parked: value.parked.filter(isParkedDraft) }
                : {}),
              ...(isAttachedAbout(value.about) ? { about: value.about } : {}),
              ...(typeof value.project === "string" ? { project: value.project } : {}),
            };
      },
    );
    const saved = this.record.read();
    this.current = saved ? parseRestorableComposerDraft(saved) : null;
    this.received = new Set(saved?.received);
    this.notices = saved?.notices ?? [];
    this.handBacksPending = saved?.handBacks ?? [];
    this.mintsChat = scope.kind !== "chat";
    this.chatId = saved?.chatId ?? crypto.randomUUID();
    this.parked = saved?.parked ?? [];
    this.attached = saved?.about ?? null;
    this.project = saved?.project ?? null;
  }

  get initialDraft(): ComposerDraftSnapshot | null {
    return this.current && parseRestorableComposerDraft(this.current);
  }

  updateDraft = (change: ComposerDraftChange): void => {
    this.current = change.snapshot;
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (!change.text) this.flush();
    else this.timer = setTimeout(this.flush, 250);
  };

  /** Call only after the submission journal has durably accepted ownership. */
  handoff = (): void => {
    const next = this.parked.at(-1);
    this.parked = this.parked.slice(0, -1);
    this.current = next ? next.draft : null;
    this.notices = [];
    this.chatId = next ? next.chatId : crypto.randomUUID();
    this.attached = null;
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
                  ...this.chatField(),
                }
              : undefined,
          )
        : this.record.write({
            ...draft,
            received: [...this.received],
            notices: this.notices,
            handBacks: this.handBacksPending,
            ...this.chatField(),
          });
    if (saved) this.dirty = false;
  };
}

const sentWords = (doc: MessageDoc): ComposerDraftSnapshot => ({
  revision: 0,
  selection: { anchor: 1, head: 1 },
  ownedUploads: [],
  doc: doc as ComposerDraftSnapshot["doc"],
});

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
