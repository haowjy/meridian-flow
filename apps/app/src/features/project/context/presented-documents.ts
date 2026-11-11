/**
 * The documents this browser tab's hosts mount, each under a token minted per mount. Main's and
 * the side's are presented: a removal, a notice or an availability watch acts on them. A kept
 * host (the last document shown that is no longer on screen, mounted hidden for its undo) is
 * mounted but not presented. One document has at most one host, so the document id names it.
 *
 * `shown` is the mounted documents newest first by when they were last on screen: the desktop
 * picks its kept host and the side's fallback from it. A close, a Discard or a removal `forget`s a
 * document, so it is no longer picked and its host unmounts.
 */
import type { OpenDocument } from "@/client/stores";

export type PresentedPlace = "main" | "side";
export type MountedPlace = PresentedPlace | "kept";

type Mount = {
  projectId: string;
  document: OpenDocument;
  place: MountedPlace;
  /** When it was last put on screen; null once forgotten. */
  shownAt: number | null;
};

const NONE: readonly OpenDocument[] = [];

export class PresentedDocuments {
  private readonly mounts = new Map<string, Mount>();
  private readonly presentedLists = new Map<string, readonly OpenDocument[]>();
  private readonly shownLists = new Map<string, readonly OpenDocument[]>();
  private readonly listeners = new Set<() => void>();
  private clock = 0;

  /** `presented` hears each new presentation: an open can land after a removal raced it. */
  constructor(
    private readonly presented: (projectId: string, tab: OpenDocument) => void = () => {},
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  mount(token: string, projectId: string, tab: OpenDocument, place: MountedPlace): void {
    const prior = this.mounts.get(token);
    const sameDocument =
      prior?.projectId === projectId && prior.document.documentId === tab.documentId;
    if (
      sameDocument &&
      prior.place === place &&
      JSON.stringify(prior.document) === JSON.stringify(tab)
    )
      return;
    const arrives = place !== "kept" && (!sameDocument || prior.place === "kept");
    const shownAt = arrives ? ++this.clock : sameDocument ? prior.shownAt : null;
    this.mounts.set(token, { projectId, document: tab, place, shownAt });
    this.changed(projectId);
    if (prior && prior.projectId !== projectId) this.changed(prior.projectId);
    if (arrives) this.presented(projectId, tab);
  }

  unmount(token: string): void {
    const mount = this.mounts.get(token);
    if (!mount) return;
    this.mounts.delete(token);
    this.changed(mount.projectId);
  }

  /** The writer closed or Discarded these documents, or they were removed: none is picked again. */
  forget(projectId: string, documentIds: readonly string[]): void {
    let changed = false;
    for (const mount of this.mounts.values())
      if (
        mount.projectId === projectId &&
        mount.shownAt !== null &&
        documentIds.includes(mount.document.documentId)
      ) {
        mount.shownAt = null;
        changed = true;
      }
    if (changed) this.changed(projectId);
  }

  /** One descriptor per presented document (main's and the side's), main's first. */
  documents(projectId: string): readonly OpenDocument[] {
    return this.cached(this.presentedLists, projectId, () =>
      [...this.mounts.values()]
        .filter((mount) => mount.projectId === projectId && mount.place !== "kept")
        .sort((left, right) => (left.place === "main" ? 0 : 1) - (right.place === "main" ? 0 : 1)),
    );
  }

  /** The mounted documents not forgotten, newest on screen first, at their current descriptor. */
  shown(projectId: string): readonly OpenDocument[] {
    return this.cached(this.shownLists, projectId, () =>
      [...this.mounts.values()]
        .filter((mount) => mount.projectId === projectId && mount.shownAt !== null)
        .sort((left, right) => (right.shownAt ?? 0) - (left.shownAt ?? 0)),
    );
  }

  /** The document main presents, if any. */
  mainDocumentId(projectId: string): string | null {
    for (const mount of this.mounts.values())
      if (mount.projectId === projectId && mount.place === "main") return mount.document.documentId;
    return null;
  }

  /** Whether any host here mounts it, the kept one included. */
  isMounted(projectId: string, documentId: string): boolean {
    for (const mount of this.mounts.values())
      if (mount.projectId === projectId && mount.document.documentId === documentId) return true;
    return false;
  }

  isPresented(projectId: string, documentId: string): boolean {
    return this.documents(projectId).some((tab) => tab.documentId === documentId);
  }

  /** The same array until its contents change, so readers re-render only on a real change. */
  private cached(
    lists: Map<string, readonly OpenDocument[]>,
    projectId: string,
    select: () => Mount[],
  ): readonly OpenDocument[] {
    const cached = lists.get(projectId);
    if (cached) return cached;
    const seen = new Set<string>();
    const next = select().flatMap((mount) => {
      if (seen.has(mount.document.documentId)) return [];
      seen.add(mount.document.documentId);
      return [mount.document];
    });
    const list = next.length === 0 ? NONE : next;
    lists.set(projectId, list);
    return list;
  }

  private changed(projectId: string): void {
    const stale = [this.presentedLists, this.shownLists].map(
      (lists) => [lists, lists.get(projectId)] as const,
    );
    for (const [lists] of stale) lists.delete(projectId);
    // A change to a kept host's descriptor leaves `documents` as it was: keep its array.
    for (const [lists, prior] of stale) {
      const next =
        lists === this.presentedLists ? this.documents(projectId) : this.shown(projectId);
      lists.set(projectId, prior && sameTabs(prior, next) ? prior : next);
    }
    for (const listener of [...this.listeners]) listener();
  }
}

function sameTabs(left: readonly OpenDocument[], right: readonly OpenDocument[]): boolean {
  return left.length === right.length && left.every((tab, index) => tab === right[index]);
}
