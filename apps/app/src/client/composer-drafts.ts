/** Tab-local authoring owner for pane continuity, journal hand-off and Edit. */
import type { ComposerDraftChange, ComposerDraftSnapshot } from "@/components/app/composer";
import {
  parseRestorableComposerDraft,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { browserRecord, isRecord, type StorageSource } from "./storage/browser-record";

export type ComposerDraftScope = { kind: "chat" | "new-chat"; id: string };

export type DeletedChatNotice = { threadId: string; title: string | null; count: number };

type StoredComposerDraft = (ComposerDraftSnapshot | { doc: null }) & {
  received?: string[];
  notices?: DeletedChatNotice[];
};

export class ComposerSessionDraft {
  readonly key: string;
  private readonly record: ReturnType<typeof browserRecord<StoredComposerDraft>>;
  private current: ComposerDraftSnapshot | null;
  private received = new Set<string>();
  notices: DeletedChatNotice[] = [];
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
    notice?: DeletedChatNotice,
  ): boolean {
    const pending = snapshots.filter(
      (_, index) => !recordIds[index] || !this.hasReceived(recordIds[index]),
    );
    if (!pending.length) return true;
    snapshots = pending;
    const first = snapshots[0];
    if (!first) return false;
    const all = [...snapshots];
    if (this.current && serializeComposerDraft(this.current.doc).text) all.push(this.current);
    const edited = {
      ...first,
      revision: Math.max(...all.map((snapshot) => snapshot.revision)) + 1,
      doc: { type: "doc", content: all.flatMap((snapshot) => snapshot.doc.content ?? []) },
      ownedUploads: all.flatMap((snapshot) => snapshot.ownedUploads),
    };
    const received = new Set([...this.received, ...recordIds]);
    const notices = notice
      ? [...this.notices.filter((item) => item.threadId !== notice.threadId), notice]
      : this.notices;
    if (!this.record.write({ ...edited, received: [...received], notices })) return false;
    this.notices = notices;
    this.received = received;
    this.current = edited;
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
          : { ...(draft ?? { doc: null }), received, notices: notices as DeletedChatNotice[] };
      },
    );
    const saved = this.record.read();
    this.current = saved ? parseRestorableComposerDraft(saved) : null;
    this.received = new Set(saved?.received);
    this.notices = saved?.notices ?? [];
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
            this.received.size
              ? { doc: null, received: [...this.received], notices: this.notices }
              : undefined,
          )
        : this.record.write({ ...draft, received: [...this.received], notices: this.notices });
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
