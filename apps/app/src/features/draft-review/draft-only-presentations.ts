/**
 * The draft-only documents on screen: documents live lacks (a page a draft created, or one deleted
 * live while a draft still has it) that are shown through their draft. Two things present one:
 * a host mount, under a token of its own, so a late answer about an earlier presentation of the
 * same item cannot settle a newer one; and a live delete of a document a draft held open, one
 * entry per held draft, so the hold lasts exactly as long as its draft or the live delete.
 * `DraftOnlySettlement` settles every presentation: promoted when live has the document again,
 * removed when the draft is gone.
 */
import type { ContextUri } from "@/lib/context-uri";
import type { DraftRef } from "./review-command-types";

export type DraftOnlyPresentation = DraftRef & {
  /** Minted per host mount, or derived from the held draft for a live delete's hold. */
  token: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
};

/** A draft held open when live deleted its document, and where that document was. */
export type HeldDraft = DraftRef & { contextLocation: Pick<ContextUri, "scheme" | "path"> };

/** What one mount's presentation is now: never presented, draft-only, or live again. */
export type PresentationState = "absent" | "draft-only" | "promoted";

const NONE: readonly DraftOnlyPresentation[] = [];
const holdToken = (draft: DraftRef) =>
  `hold:${JSON.stringify([draft.projectId, draft.documentId, draft.ownerKey, draft.itemKey])}`;

export class DraftOnlyPresentations {
  private readonly entries = new Map<string, DraftOnlyPresentation>();
  /** Mount tokens whose document live has again; a hold is deleted instead. */
  private readonly promoted = new Set<string>();
  private readonly holds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly byProject = new Map<string, readonly DraftOnlyPresentation[]>();
  /** Bumped on every change: a snapshot for readers of `isDraftOnly`. */
  version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Presents (or re-presents, for a changed draft) one mount's document as draft-only. */
  present(entry: DraftOnlyPresentation): void {
    const prior = this.entries.get(entry.token);
    if (prior && !this.promoted.has(entry.token) && JSON.stringify(prior) === JSON.stringify(entry))
      return;
    this.entries.set(entry.token, entry);
    this.promoted.delete(entry.token);
    this.changed(entry.projectId);
  }

  /** The mount ended, or the held draft did. */
  withdraw(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.promoted.delete(token);
    this.holds.delete(token);
    this.changed(entry.projectId);
  }

  state(token: string): PresentationState {
    if (!this.entries.has(token)) return "absent";
    return this.promoted.has(token) ? "promoted" : "draft-only";
  }

  /** Whether `token` is a live delete's hold rather than a host mount. */
  isHold(token: string): boolean {
    return this.holds.has(token);
  }

  /** Live has the document (again): its holds end and every mount of it opens the live document. */
  promote(projectId: string, documentId: string): void {
    let changed = false;
    for (const [token, entry] of this.entries) {
      if (entry.projectId !== projectId || entry.documentId !== documentId) continue;
      if (this.holds.has(token)) {
        this.entries.delete(token);
        this.holds.delete(token);
        changed = true;
      } else if (!this.promoted.has(token)) {
        this.promoted.add(token);
        changed = true;
      }
    }
    if (changed) this.changed(projectId);
  }

  /**
   * Live deleted a document that these drafts, held open, still have: each keeps it draft-only
   * until it ends or live has the document again, and the hosts showing it paint the draft,
   * without its live room.
   */
  holdRemovedLive(projectId: string, documentId: string, drafts: readonly HeldDraft[]): void {
    for (const draft of drafts) {
      const token = holdToken(draft);
      this.entries.set(token, { ...draft, token });
      this.holds.add(token);
    }
    for (const [token, entry] of this.entries)
      if (entry.projectId === projectId && entry.documentId === documentId)
        this.promoted.delete(token);
    this.changed(projectId);
  }

  /** Something presents this document draft-only now. */
  isDraftOnly(projectId: string, documentId: string): boolean {
    for (const [token, entry] of this.entries)
      if (
        entry.projectId === projectId &&
        entry.documentId === documentId &&
        !this.promoted.has(token)
      )
        return true;
    return false;
  }

  /** The draft-only presentations of a project; the same array until one changes. */
  presentations(projectId: string): readonly DraftOnlyPresentation[] {
    let list = this.byProject.get(projectId);
    if (!list) {
      list = [...this.entries].flatMap(([token, entry]) =>
        entry.projectId === projectId && !this.promoted.has(token) ? [entry] : [],
      );
      this.byProject.set(projectId, list.length ? list : NONE);
    }
    return list;
  }

  private changed(projectId: string): void {
    this.version += 1;
    this.byProject.delete(projectId);
    for (const listener of [...this.listeners]) listener();
  }
}
