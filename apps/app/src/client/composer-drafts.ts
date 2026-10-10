/** Tab-local owner shared by authoring panes and admission settlement. */
import type { ComposerDraftChange, ComposerDraftSnapshot } from "@/components/app/composer";
import {
  parseRestorableComposerDraft,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { browserRecord, type StorageSource } from "./storage/browser-record";

export type ComposerDraftScope = { kind: "chat" | "new-chat"; id: string };

export class ComposerSessionDraft {
  readonly key: string;
  private readonly record: ReturnType<typeof browserRecord<ComposerDraftSnapshot>>;
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
    if (this.current && serializeComposerDraft(this.current.doc).text) {
      this.flush();
      return false;
    }
    if (!this.current || !serializeComposerDraft(this.current.doc).text) {
      this.current = snapshot;
      this.dirty = true;
      this.publish();
    }
    this.flush();
    return !this.dirty;
  }

  /** Writer-directed Edit prepends the rejected document without flattening reference atoms. */
  editRejected(snapshot: ComposerDraftSnapshot): boolean {
    const later = this.current;
    const edited =
      later && serializeComposerDraft(later.doc).text
        ? {
            ...snapshot,
            revision: Math.max(snapshot.revision, later.revision) + 1,
            doc: {
              type: "doc",
              content: [...(snapshot.doc.content ?? []), ...(later.doc.content ?? [])],
            },
            ownedUploads: [...snapshot.ownedUploads, ...later.ownedUploads],
          }
        : snapshot;
    if (!this.record.write(edited)) return false;
    this.current = edited;
    this.dirty = false;
    this.publish();
    return true;
  }

  /** Once recorded, only the exact unchanged authoring draft transfers to the journal. */
  handoffSubmitted(snapshot: ComposerDraftSnapshot): void {
    if (this.matches(snapshot)) this.handoff();
  }

  /** Every authoring update after journal hand-off is newer, even with identical words/revision. */
  acceptSubmitted(): boolean {
    if (!this.current) {
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

  constructor(accountId: string, scope: ComposerDraftScope, storage: StorageSource = "session") {
    this.key = `meridian:composer-draft:v1:${JSON.stringify([accountId, scope.kind, scope.id])}`;
    this.record = browserRecord(
      storage,
      { key: this.key, version: 1, accountId, scope: JSON.stringify([scope.kind, scope.id]) },
      (value) => parseRestorableComposerDraft(value) ?? undefined,
    );
    this.current = this.record.read() ?? null;
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
    const draft = this.current && parseRestorableComposerDraft(this.current);
    const saved =
      !draft || !serializeComposerDraft(draft.doc).text
        ? this.record.write(undefined)
        : this.record.write(draft);
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
