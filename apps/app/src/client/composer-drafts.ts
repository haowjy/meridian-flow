/** Tab-local owner shared by authoring panes and admission settlement. */
import type { ComposerDraftChange, ComposerDraftSnapshot } from "@/components/app/composer";
import {
  parseRestorableComposerDraft,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
export type ComposerDraftScope = { kind: "chat" | "new-chat"; id: string };
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class ComposerSessionDraft {
  readonly key: string;
  private current: ComposerDraftSnapshot | null;
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

  /** Transfer rejection ownership before the journal is retired. Never replace later authoring. */
  restoreRejected(snapshot: ComposerDraftSnapshot): boolean {
    if (!this.current) {
      this.current = snapshot;
      this.dirty = true;
      this.publish();
    }
    this.flush();
    return !this.dirty;
  }

  /** Once recorded, only the exact unchanged authoring draft transfers to the journal. */
  handoffSubmitted(snapshot: ComposerDraftSnapshot): void {
    if (this.matches(snapshot)) this.handoff();
  }

  /** Clear a journal-owned live draft or its unchanged retained copy, never later writing. */
  clearSubmitted(snapshot: ComposerDraftSnapshot): boolean {
    if (!this.current || this.matches(snapshot)) {
      this.handoff();
      this.publish();
    } else this.flush();
    return !this.dirty;
  }

  private matches(snapshot: ComposerDraftSnapshot): boolean {
    // Selection movement is not editing. Normalize both sides so storage parsing
    // and object property order cannot change a structured document's identity.
    return (
      this.current?.revision === snapshot.revision &&
      JSON.stringify(parseRestorableComposerDraft(this.current)?.doc) ===
        JSON.stringify(parseRestorableComposerDraft(snapshot)?.doc)
    );
  }

  constructor(
    private accountId: string,
    scope: ComposerDraftScope,
    private storage: () => StoragePort = () => window.sessionStorage,
  ) {
    this.key = `meridian:composer-draft:v1:${JSON.stringify([accountId, scope.kind, scope.id])}`;
    let draft: ComposerDraftSnapshot | null = null;
    try {
      const raw = this.storage().getItem(this.key);
      const record = raw ? JSON.parse(raw) : null;
      if (record?.version === 1 && record.accountId === accountId)
        draft = parseRestorableComposerDraft(record.draft);
    } catch {
      /* Storage is best effort; the live editor is always usable. */
    }
    this.current = draft;
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
    this.dirty = true;
    this.flush();
  };

  flush = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    try {
      const draft = this.current && parseRestorableComposerDraft(this.current);
      if (!draft || !serializeComposerDraft(draft.doc).text) this.storage().removeItem(this.key);
      else
        this.storage().setItem(
          this.key,
          JSON.stringify({ version: 1, accountId: this.accountId, draft }),
        );
      this.dirty = false;
    } catch {
      /* A denied/quota-full store must not interrupt authoring or Send. */
    }
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
