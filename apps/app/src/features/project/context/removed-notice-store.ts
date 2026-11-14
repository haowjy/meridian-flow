/**
 * The notice for documents that vanished from under the writer, one per project. A view pushes a
 * document it presented when it vanished; the list says whether it was removed and by whom, and
 * only a removal the list shows is shown. A delete this tab's writer just made says nothing: the
 * view left on its own. The same account deleting from another tab or device does.
 */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { OpenDocument } from "@/client/stores";
import type { ProjectStandings } from "./project-standings";
import { removalAnswer } from "./removal-answer";

/** A presented document that vanished, as its presenter showed it. */
export type PresentedRemoval = Readonly<{
  documentId: string;
  title: string;
  /** The address its view showed, so the notice knows when the view has left it. */
  route: Readonly<{ scheme: string; path: string }>;
}>;

/** A removal the notice shows, with who deleted it (null: the list does not say). */
export type ShownRemoval = PresentedRemoval & { record: DocumentRemovalRecord | null };

/**
 * `shown` is what the notice says. `waiting` holds documents the list has not answered for yet:
 * the notice's lifetime covers them too, so a removal read after the writer moved on never
 * surfaces late. `version` changes whenever either does, which re-anchors the lifetime; 0 is no
 * notice.
 */
export type RemovedNoticeSnapshot = Readonly<{
  shown: readonly ShownRemoval[];
  waiting: readonly PresentedRemoval[];
  version: number;
}>;

const OWN_REMOVAL_MS = 15_000;

const EMPTY: RemovedNoticeSnapshot = { shown: [], waiting: [], version: 0 };

type Entries = { removals: Map<string, PresentedRemoval>; stop: () => void };

export class RemovedNoticeStore {
  private readonly projects = new Map<string, Entries>();
  private readonly snapshots = new Map<string, RemovedNoticeSnapshot>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  /** Documents this tab is deleting, until when: their notice is not shown. */
  private readonly own = new Map<string, number>();

  constructor(private readonly standings: Pick<ProjectStandings, "watch" | "standing">) {}

  /** The writer is deleting these documents here: the list's answer about them is not news. */
  markOwnRemoval(projectId: string, documentIds: readonly string[]): void {
    const until = Date.now() + OWN_REMOVAL_MS;
    for (const id of documentIds) this.own.set(`${projectId}/${id}`, until);
  }

  /** Documents a view was presenting that vanished. */
  presentedRemoved(projectId: string, tabs: readonly OpenDocument[]): void {
    let entries = this.projects.get(projectId);
    for (const tab of tabs) {
      if (tab.kind === "new" || entries?.removals.has(tab.documentId)) continue;
      entries ??= {
        removals: new Map(),
        stop: this.standings.watch(projectId, () => this.refresh(projectId)),
      };
      this.projects.set(projectId, entries);
      entries.removals.set(tab.documentId, {
        documentId: tab.documentId,
        title: tab.name,
        route: { scheme: tab.scheme, path: tab.path },
      });
    }
    if (entries) this.refresh(projectId);
  }

  snapshot(projectId: string): RemovedNoticeSnapshot {
    return this.snapshots.get(projectId) ?? EMPTY;
  }

  dismiss(projectId: string): void {
    this.projects.get(projectId)?.stop();
    this.projects.delete(projectId);
    this.refresh(projectId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private refresh(projectId: string): void {
    const entries = this.projects.get(projectId);
    const shown: ShownRemoval[] = [];
    const waiting: PresentedRemoval[] = [];
    for (const removal of entries?.removals.values() ?? []) {
      const answer = removalAnswer(this.standings.standing(projectId, removal.documentId));
      if (answer?.kind === "removed") {
        // The writer's own delete: the view left on its own, so there is nothing to explain.
        if ((this.own.get(`${projectId}/${removal.documentId}`) ?? 0) > Date.now()) {
          entries?.removals.delete(removal.documentId);
          continue;
        }
        shown.push({ ...removal, record: answer.record });
      } else waiting.push(removal);
    }
    if (entries && entries.removals.size === 0) {
      entries.stop();
      this.projects.delete(projectId);
    }
    const prior = this.snapshots.get(projectId);
    if (!prior && !shown.length && !waiting.length) return;
    if (
      prior &&
      prior.waiting.length === waiting.length &&
      prior.shown.length === shown.length &&
      prior.shown.every(
        (document, index) =>
          document.documentId === shown[index]?.documentId &&
          JSON.stringify(document.record?.actor) === JSON.stringify(shown[index]?.record?.actor),
      )
    )
      return;
    if (!shown.length && !waiting.length) this.snapshots.delete(projectId);
    else this.snapshots.set(projectId, { shown, waiting, version: ++this.version });
    for (const listener of [...this.listeners]) listener();
  }
}
