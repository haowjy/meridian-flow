/**
 * The draft-only documents on screen: documents live lacks (a page a draft created, or one deleted
 * live while a draft still has it) that a mounted host presents through their draft. Each host
 * mount presents under a token of its own, so a late answer about an earlier presentation of the
 * same item cannot settle a newer one. `DraftOnlySettlement` settles every presentation: promoted
 * when live has the document again, removed when the draft is gone.
 */
import type { ContextUri } from "@/lib/context-uri";
import type { DraftRef } from "./review-command-types";

export type DraftOnlyPresentation = DraftRef & {
  /** Minted per host mount. */
  token: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
};

/** What one mount's presentation is now: never presented, draft-only, or live again. */
export type PresentationState = "absent" | "draft-only" | "promoted";

const NONE: readonly DraftOnlyPresentation[] = [];
const documentKey = (projectId: string, documentId: string) =>
  JSON.stringify([projectId, documentId]);

export class DraftOnlyPresentations {
  private readonly entries = new Map<string, DraftOnlyPresentation>();
  private readonly promoted = new Set<string>();
  /** Documents live deleted while a draft held open still has them. */
  private readonly removedLive = new Set<string>();
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

  /** The mount ended. */
  withdraw(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.promoted.delete(token);
    this.changed(entry.projectId);
  }

  state(token: string): PresentationState {
    if (!this.entries.has(token)) return "absent";
    return this.promoted.has(token) ? "promoted" : "draft-only";
  }

  /** Live has the document (again): every presentation of it opens the live document. */
  promote(projectId: string, documentId: string): void {
    let changed = this.removedLive.delete(documentKey(projectId, documentId));
    for (const [token, entry] of this.entries) {
      if (entry.projectId !== projectId || entry.documentId !== documentId) continue;
      if (this.promoted.has(token)) continue;
      this.promoted.add(token);
      changed = true;
    }
    if (changed) this.changed(projectId);
  }

  /**
   * Live deleted a document that a draft held open still has: the hosts showing it keep painting
   * the draft, without its live room, until a restore promotes them again.
   */
  holdRemovedLive(projectId: string, documentId: string): void {
    this.removedLive.add(documentKey(projectId, documentId));
    for (const [token, entry] of this.entries)
      if (entry.projectId === projectId && entry.documentId === documentId)
        this.promoted.delete(token);
    this.changed(projectId);
  }

  /** Some host presents this document draft-only now, or live deleted it while a draft holds it. */
  isDraftOnly(projectId: string, documentId: string): boolean {
    if (this.removedLive.has(documentKey(projectId, documentId))) return true;
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
