/**
 * The notice for documents that vanished from under the writer, one per project.
 * A view pushes a document it presented when it vanished; the availability record cache says
 * whether and how it was removed, and only a proven removal shows. The writer's own delete or
 * Discard marks its documents first, so its removals say nothing.
 */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import type { PresentedDocuments } from "./presented-documents";
import type {
  ProjectContextAvailabilityCoordinator,
  RemovalAnswer,
} from "./project-context-availability-coordinator";

/** A presented document that vanished, as its presenter showed it. */
export type PresentedRemoval = Readonly<{
  documentId: string;
  title: string;
  /** The address its view showed, so the notice knows when the view has left it. */
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

/** Settles an own removal with the documents it did not remove. */
export type SettleOwnRemoval = (kept: readonly string[]) => void;

/**
 * A delete or Discard the writer sent: by covered document, whether its removal was seen (a view
 * saw it vanish, or it landed) yet. It lasts until settled and every one has.
 */
type OwnRemovalMark = { seen: Map<string, boolean>; settled: boolean };

export class RemovedNoticeStore {
  private readonly notices = new Map<string, Map<string, Entry>>();
  private readonly snapshots = new Map<string, RemovedNoticeSnapshot>();
  private readonly ownRemovals = new Map<string, Set<OwnRemovalMark>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly availability: Pick<ProjectContextAvailabilityCoordinator, "removalRecord">,
    private readonly presented: Pick<PresentedDocuments, "isPresented">,
  ) {}

  /** Documents a view was presenting that vanished. */
  presentedRemoved(projectId: string, tabs: readonly ContextTab[]): void {
    const key = projectKey(projectId);
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
        this.coveredByOwnRemoval(projectId, removal.documentId)
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

  snapshot(projectId: string): RemovedNoticeSnapshot {
    return this.snapshots.get(projectKey(projectId)) ?? EMPTY;
  }

  dismiss(projectId: string): void {
    const key = projectKey(projectId);
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
   * The writer is removing these documents (a tree delete or Discard), so their removal says
   * nothing. Only documents a view presents are covered: nothing else is ever pushed. Call
   * before the request and settle the returned mark with the documents it did not remove: those
   * are released at once, and each removed one stays covered until its removal lands.
   */
  markOwnRemoval(projectId: string, documentIds: readonly string[]): SettleOwnRemoval {
    const mark: OwnRemovalMark = { seen: new Map(), settled: false };
    for (const documentId of documentIds) {
      if (!this.presented.isPresented(projectId, documentId)) continue;
      const key = documentKey(projectId, documentId);
      mark.seen.set(key, false);
      const marks = this.ownRemovals.get(key) ?? new Set();
      marks.add(mark);
      this.ownRemovals.set(key, marks);
    }
    return (kept) => {
      if (mark.settled) return;
      mark.settled = true;
      const keptKeys = new Set(kept.map((documentId) => documentKey(projectId, documentId)));
      for (const [key, seen] of [...mark.seen])
        if (keptKeys.has(key) || seen) this.dropOwnRemovalMark(key, mark);
    };
  }

  /**
   * These documents' removal landed, wherever they are now: a view that had already left one
   * never sees it vanish, so the marks covering it end here, or at their settling.
   */
  removalsLanded(projectId: string, documentIds: readonly string[]): void {
    for (const documentId of documentIds) {
      const key = documentKey(projectId, documentId);
      for (const mark of [...(this.ownRemovals.get(key) ?? [])]) {
        mark.seen.set(key, true);
        if (mark.settled) this.dropOwnRemovalMark(key, mark);
      }
    }
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
   * Whether the writer's own request covers the removal: every sighting is silent while the mark
   * lives, and the first one counts as seen.
   */
  private coveredByOwnRemoval(projectId: string, documentId: string): boolean {
    const key = documentKey(projectId, documentId);
    const [mark] = this.ownRemovals.get(key) ?? [];
    if (!mark?.seen.has(key)) return false;
    mark.seen.set(key, true);
    if (mark.settled) this.dropOwnRemovalMark(key, mark);
    return true;
  }

  private dropOwnRemovalMark(key: string, mark: OwnRemovalMark): void {
    mark.seen.delete(key);
    const marks = this.ownRemovals.get(key);
    marks?.delete(mark);
    if (marks?.size === 0) this.ownRemovals.delete(key);
  }
}

function projectKey(projectId: string): string {
  return JSON.stringify([projectId]);
}

function documentKey(projectId: string, documentId: string): string {
  return JSON.stringify([projectId, documentId]);
}
