/**
 * The notice for documents that closed under the writer, one per project and
 * surface (Editor tabs, the dock). Whatever presented a document pushes it
 * when its document vanished; the availability record cache says whether and
 * how it was removed, and only a proven removal shows. The tab's own delete or
 * Discard marks its documents first, so its removals say nothing.
 */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { type ContextTab, getContextTabs } from "@/client/stores";
import { useDockDocumentStore } from "../dock/dock-document-store";
import type {
  ProjectContextAvailabilityCoordinator,
  RemovalAnswer,
} from "./project-context-availability-coordinator";

/** Where a removed document was showing: the Editor's tabs, or the dock beside Chat or Work. */
export type NoticeSurface = "editor" | "dock";

/** A presented document that vanished, as its presenter showed it. */
export type PresentedRemoval = Readonly<{
  documentId: string;
  title: string;
  /** The address its tab showed, so the notice knows when the pane has left it. */
  route: Readonly<{ scheme: string; path: string }>;
}>;

/** A removal the notice shows, with the server's record (null: none kept). */
export type ShownRemoval = PresentedRemoval & { record: DocumentRemovalRecord | null };

/**
 * `shown` is what the notice says. `waiting` holds documents still waiting
 * for their answer: the notice's lifetime covers them too, so a removal
 * proven after the writer moved on never surfaces late. `version` changes
 * whenever either does, which re-anchors the lifetime; 0 is no notice.
 */
export type RemovedNoticeSnapshot = Readonly<{
  shown: readonly ShownRemoval[];
  waiting: readonly PresentedRemoval[];
  version: number;
}>;

const EMPTY: RemovedNoticeSnapshot = { shown: [], waiting: [], version: 0 };

type Entry = { removal: PresentedRemoval; stop: () => void };

/**
 * A delete or Discard this tab sent: by covered document, the surfaces that
 * presented it and have not yet seen it vanish. It lasts until settled and
 * every one of them has.
 */
type OwnRemovalMark = { unseen: Map<string, Set<NoticeSurface>>; settled: boolean };

export class RemovedNoticeStore {
  private readonly notices = new Map<string, Map<string, Entry>>();
  private readonly snapshots = new Map<string, RemovedNoticeSnapshot>();
  private readonly ownRemovals = new Map<string, Set<OwnRemovalMark>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly availability: Pick<ProjectContextAvailabilityCoordinator, "removalRecord">,
  ) {}

  /** Tabs a surface was presenting closed because their documents vanished. */
  presentedRemoved(projectId: string, surface: NoticeSurface, tabs: readonly ContextTab[]): void {
    const key = noticeKey(projectId, surface);
    let changed = false;
    for (const tab of tabs) {
      if (tab.kind === "new") continue;
      const removal: PresentedRemoval = {
        documentId: tab.documentId,
        title: tab.name,
        route: { scheme: tab.scheme, path: tab.path },
      };
      const entries = this.notices.get(key) ?? new Map<string, Entry>();
      if (
        entries.has(removal.documentId) ||
        this.coveredByOwnRemoval(projectId, surface, removal.documentId)
      )
        continue;
      const record = this.availability.removalRecord(projectId, removal.documentId);
      const entry: Entry = { removal, stop: () => undefined };
      entries.set(removal.documentId, entry);
      this.notices.set(key, entries);
      entry.stop = record.subscribe(() => this.answered(key, removal.documentId, record.get()));
      changed = true;
      // An answer already known settles the entry now.
      this.answered(key, removal.documentId, record.get(), false);
    }
    if (changed) this.changed(key);
  }

  snapshot(projectId: string, surface: NoticeSurface): RemovedNoticeSnapshot {
    return this.snapshots.get(noticeKey(projectId, surface)) ?? EMPTY;
  }

  dismiss(projectId: string, surface: NoticeSurface): void {
    const key = noticeKey(projectId, surface);
    const entries = this.notices.get(key);
    if (!entries) return;
    for (const entry of entries.values()) entry.stop();
    this.notices.delete(key);
    this.changed(key);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The tab is removing these documents itself (a tree delete or Discard), so
   * their removal says nothing. Only documents a tab or the dock presents are
   * covered: nothing else is ever pushed. Call before the request and settle
   * the returned mark in a `finally`: "kept" releases it; "removed" keeps each
   * document covered until every surface that presented it saw it vanish.
   */
  markOwnRemoval(
    projectId: string,
    documentIds: readonly string[],
  ): (outcome: "removed" | "kept") => void {
    const mark: OwnRemovalMark = { unseen: new Map(), settled: false };
    for (const documentId of documentIds) {
      const surfaces = presentingSurfaces(projectId, documentId);
      if (surfaces.size === 0) continue;
      const key = documentKey(projectId, documentId);
      mark.unseen.set(key, surfaces);
      const marks = this.ownRemovals.get(key) ?? new Set();
      marks.add(mark);
      this.ownRemovals.set(key, marks);
    }
    return (outcome) => {
      if (mark.settled) return;
      mark.settled = true;
      for (const [key, surfaces] of [...mark.unseen])
        if (outcome === "kept" || surfaces.size === 0) this.dropOwnRemovalMark(key, mark);
    };
  }

  /**
   * Settles an entry from its answer. A Work's removal
   * or an authority loss keeps its own handling and leaves the notice.
   * `available` keeps waiting: it can precede the commit of a delete the
   * shared local replica already applied.
   */
  private answered(
    key: string,
    documentId: string,
    answer: RemovalAnswer | undefined,
    publish = true,
  ): void {
    const entries = this.notices.get(key);
    const entry = entries?.get(documentId);
    if (!entries || !entry) return;
    const drop =
      answer?.kind === "lost" ||
      (answer?.kind === "removed" && answer.record?.actor?.kind === "work");
    if (drop) {
      entry.stop();
      entries.delete(documentId);
      if (entries.size === 0) this.notices.delete(key);
    }
    if (publish) this.changed(key);
  }

  private changed(key: string): void {
    const entries = [...(this.notices.get(key)?.values() ?? [])];
    const projectId = JSON.parse(key)[0] as string;
    const shown: ShownRemoval[] = [];
    const waiting: PresentedRemoval[] = [];
    for (const { removal } of entries) {
      const answer = this.availability.removalRecord(projectId, removal.documentId).get();
      if (answer?.kind === "removed") shown.push({ ...removal, record: answer.record });
      else waiting.push(removal);
    }
    const prior = this.snapshots.get(key);
    if (!prior && entries.length === 0) return;
    if (
      prior &&
      prior.waiting.length === waiting.length &&
      prior.shown.length === shown.length &&
      prior.shown.every(
        (document, index) =>
          document.documentId === shown[index]?.documentId &&
          document.record === shown[index]?.record,
      )
    )
      return;
    if (entries.length === 0) this.snapshots.delete(key);
    else this.snapshots.set(key, { shown, waiting, version: ++this.version });
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Whether this tab's own request covers the removal: every sighting is
   * silent while the mark lives, and each one uses up its surface.
   */
  private coveredByOwnRemoval(
    projectId: string,
    surface: NoticeSurface,
    documentId: string,
  ): boolean {
    const key = documentKey(projectId, documentId);
    const [mark] = this.ownRemovals.get(key) ?? [];
    const surfaces = mark?.unseen.get(key);
    if (!mark || !surfaces) return false;
    surfaces.delete(surface);
    if (mark.settled && surfaces.size === 0) this.dropOwnRemovalMark(key, mark);
    return true;
  }

  private dropOwnRemovalMark(key: string, mark: OwnRemovalMark): void {
    mark.unseen.delete(key);
    const marks = this.ownRemovals.get(key);
    marks?.delete(mark);
    if (marks?.size === 0) this.ownRemovals.delete(key);
  }
}

function noticeKey(projectId: string, surface: NoticeSurface): string {
  return JSON.stringify([projectId, surface]);
}

function documentKey(projectId: string, documentId: string): string {
  return JSON.stringify([projectId, documentId]);
}

/** Where this browser tab presents a document: its Editor tabs, the dock, both or neither. */
function presentingSurfaces(projectId: string, documentId: string): Set<NoticeSurface> {
  const surfaces = new Set<NoticeSurface>();
  if (
    getContextTabs(projectId).tabs.some(
      (tab) => tab.kind !== "new" && tab.documentId === documentId,
    )
  )
    surfaces.add("editor");
  const occupant = useDockDocumentStore.getState().occupant;
  if (
    occupant?.projectId === projectId &&
    occupant.tab.kind !== "new" &&
    occupant.tab.documentId === documentId
  )
    surfaces.add("dock");
  return surfaces;
}
