import type { OpenDocument } from "@/client/stores";

export type PresentedPlace = "main" | "side";
export type MountedPlace = PresentedPlace | "kept";

type Mount = {
  projectId: string;
  document: OpenDocument;
  place: MountedPlace;
  shownAt: number | null;
};

const NONE: readonly OpenDocument[] = [];

export class PresentedDocuments {
  private readonly mounts = new Map<string, Mount>();
  private readonly presentedLists = new Map<string, readonly OpenDocument[]>();
  private readonly shownLists = new Map<string, readonly OpenDocument[]>();
  private readonly listeners = new Set<() => void>();
  private clock = 0;

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

  documents(projectId: string): readonly OpenDocument[] {
    return this.cached(this.presentedLists, projectId, () =>
      [...this.mounts.values()]
        .filter((mount) => mount.projectId === projectId && mount.place !== "kept")
        .sort((left, right) => (left.place === "main" ? 0 : 1) - (right.place === "main" ? 0 : 1)),
    );
  }

  shown(projectId: string): readonly OpenDocument[] {
    return this.cached(this.shownLists, projectId, () =>
      [...this.mounts.values()]
        .filter((mount) => mount.projectId === projectId && mount.shownAt !== null)
        .sort((left, right) => (right.shownAt ?? 0) - (left.shownAt ?? 0)),
    );
  }

  mainDocumentId(projectId: string): string | null {
    for (const mount of this.mounts.values())
      if (mount.projectId === projectId && mount.place === "main") return mount.document.documentId;
    return null;
  }

  isMounted(projectId: string, documentId: string): boolean {
    for (const mount of this.mounts.values())
      if (mount.projectId === projectId && mount.document.documentId === documentId) return true;
    return false;
  }

  isPresented(projectId: string, documentId: string): boolean {
    return this.documents(projectId).some((tab) => tab.documentId === documentId);
  }

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
