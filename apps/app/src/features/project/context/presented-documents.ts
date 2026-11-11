/**
 * The documents this browser tab's hosts present: main's, the side's, and the last one that left
 * main, kept mounted for its undo. A host presents its document under a token minted per mount, so
 * a removal, a notice or an availability watch knows what is on screen without a tab list. One
 * document has at most one host, so the document id names the presentation.
 */
import type { ContextTab } from "@/client/stores";

export type PresentedPlace = "main" | "side" | "kept";

type Presentation = { projectId: string; tab: ContextTab; place: PresentedPlace };

const NONE: readonly ContextTab[] = [];

export class PresentedDocuments {
  private readonly entries = new Map<string, Presentation>();
  private readonly byProject = new Map<string, readonly ContextTab[]>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every change: a snapshot for readers of `isPresented`. */
  version = 0;

  /** `presented` hears each new presentation: an open can land after a removal raced it. */
  constructor(
    private readonly presented: (projectId: string, tab: ContextTab) => void = () => {},
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  present(token: string, projectId: string, tab: ContextTab, place: PresentedPlace): void {
    const prior = this.entries.get(token);
    if (
      prior?.projectId === projectId &&
      prior.place === place &&
      JSON.stringify(prior.tab) === JSON.stringify(tab)
    )
      return;
    this.entries.set(token, { projectId, tab, place });
    this.changed(projectId);
    if (prior?.tab.documentId !== tab.documentId) this.presented(projectId, tab);
  }

  withdraw(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.changed(entry.projectId);
  }

  /** One descriptor per presented document, main's first; the same array until one changes. */
  documents(projectId: string): readonly ContextTab[] {
    let list = this.byProject.get(projectId);
    if (!list) {
      const seen = new Set<string>();
      const ordered = [...this.entries.values()]
        .filter((entry) => entry.projectId === projectId)
        .sort((left, right) => rank(left.place) - rank(right.place));
      list = ordered.flatMap((entry) => {
        if (seen.has(entry.tab.documentId)) return [];
        seen.add(entry.tab.documentId);
        return [entry.tab];
      });
      if (list.length === 0) list = NONE;
      this.byProject.set(projectId, list);
    }
    return list;
  }

  /** The document main presents, if any. */
  mainDocumentId(projectId: string): string | null {
    for (const entry of this.entries.values())
      if (entry.projectId === projectId && entry.place === "main") return entry.tab.documentId;
    return null;
  }

  isPresented(projectId: string, documentId: string): boolean {
    return this.documents(projectId).some((tab) => tab.documentId === documentId);
  }

  private changed(projectId: string): void {
    this.version += 1;
    this.byProject.delete(projectId);
    for (const listener of [...this.listeners]) listener();
  }
}

function rank(place: PresentedPlace): number {
  return place === "main" ? 0 : place === "side" ? 1 : 2;
}
