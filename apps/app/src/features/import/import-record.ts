/**
 * Everything this tab owns for one import, under one lifetime: its store, the
 * run that reads and sends, the plan and status reads in flight, and the catalog
 * handoff. Disposing the record removes all of it, so retiring an import cannot
 * leave a piece behind.
 */
import { type CatalogReader, type Clock, Handoff } from "./import-handoff";
import type { ImportState } from "./import-state";
import { ImportStore } from "./import-store";
import { type ImportTarget, targetOf } from "./placements";
import type { ProjectedImport } from "./tree-projection";
import type { UploadQueue } from "./uploader";

/**
 * What this tab is doing for an import: reading its files, the plan and the
 * sends. Aborting ends it for good; every step after an await checks `retired`
 * before it changes anything or calls the server.
 */
export type Run = { readonly controller: AbortController; readonly queue: UploadQueue };

export function retired(run: Run): boolean {
  return run.controller.signal.aborted;
}

export class ImportRecord {
  readonly store: ImportStore;
  readonly handoff: Handoff;
  readonly startedAt = Date.now();
  run: Run | null = null;
  /** The plan request in flight. */
  plan: Promise<unknown> | null = null;
  /** The status read in flight; a command's full read queues behind it. */
  read: Promise<boolean> | null = null;
  /** The server no longer knows this import. */
  missing = false;
  private view: ProjectedImport | null = null;
  private target: { state: ImportState; value: ImportTarget | null } | null = null;

  constructor(
    projectId: string,
    readonly importId: string,
    catalog: CatalogReader,
    clock: Clock,
    onExpired: () => void,
  ) {
    this.store = new ImportStore(projectId, importId);
    this.handoff = new Handoff(catalog, clock, onExpired);
  }

  /** This import as the projection reads it; the same object while nothing about it moved. */
  project(): ProjectedImport {
    const state = this.store.getSnapshot();
    if (this.target?.state !== state) this.target = { state, value: targetOf(state) };
    const { seen, bridges } = this.handoff;
    const target = this.target.value;
    const previous = this.view;
    if (
      previous &&
      previous.state === state &&
      previous.seen === seen &&
      previous.bridges === bridges &&
      previous.target === target
    )
      return previous;
    this.view = { importId: this.importId, state, seen, bridges, target };
    return this.view;
  }

  endRun() {
    const run = this.run;
    if (!run) return;
    run.controller.abort();
    run.queue.cancel();
    this.run = null;
  }

  dispose() {
    this.endRun();
    this.handoff.dispose();
    this.store.dispose();
    this.view = null;
    this.target = null;
    this.plan = null;
    this.read = null;
  }
}
