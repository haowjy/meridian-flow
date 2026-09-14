/** Serialized catalog acquisition with atomic checkpoint/resource installation. */
import type { CatalogChanges, CatalogScope, CatalogSnapshot } from "@meridian/contracts/protocol";
import { applyCatalogChanges, type CatalogCacheView, catalogViewFromSnapshot } from "./catalog";
import {
  type CatalogObservationFence,
  catalogViewFromCheckpoint,
  planCatalogInstallation,
} from "./catalog-installation";
import {
  catalogProjectionKey,
  catalogRequestBelongsToProject,
  catalogResponseMatchesRequest,
  sameCatalogProjectionScope,
} from "./catalog-scope";
import type {
  ProjectResourceSnapshot,
  ResourceCatalogCheckpoint,
  ResourceMetadataStore,
} from "./resource-records";

export interface ResourceCatalogTransport {
  readonly accountId: string;
  snapshot(projectId: string, scope: CatalogScope): Promise<CatalogSnapshot>;
  changes(projectId: string, scope: CatalogScope, cursor: string): Promise<CatalogChanges>;
}

type AcquisitionState = {
  hintedHighWater: bigint;
  inFlight: Promise<CatalogCacheView> | null;
};

function checkpointFor(
  projectId: string,
  scope: CatalogScope,
  snapshot: ProjectResourceSnapshot,
): ResourceCatalogCheckpoint | null {
  return (
    snapshot.catalogs.find(
      (checkpoint) =>
        checkpoint.projectId === projectId && sameCatalogProjectionScope(checkpoint.scope, scope),
    ) ?? null
  );
}

function observationFence(snapshot: ProjectResourceSnapshot): CatalogObservationFence {
  const resourceRevisions = new Map<string, number>();
  for (const { resource } of snapshot.records) {
    resourceRevisions.set(resource.handle, resource.revision);
  }
  return { resourceRevisions };
}

function revision(value: string): bigint | null {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function checkpointMatchesView(
  checkpoint: ResourceCatalogCheckpoint | null,
  view: CatalogCacheView,
): boolean {
  const entries = [...view.entries.values()].sort((left, right) =>
    left.entryId.localeCompare(right.entryId),
  );
  const invalidatedEntryIds = [...view.invalidatedEntryIds].sort();
  return (
    checkpoint !== null &&
    checkpoint.generation === view.generation &&
    checkpoint.appliedRevision === view.appliedRevision &&
    checkpoint.observedHeadRevision === view.observedHeadRevision &&
    checkpoint.cursor === view.cursor &&
    JSON.stringify(checkpoint.entries) === JSON.stringify(entries) &&
    JSON.stringify(checkpoint.invalidatedEntryIds) === JSON.stringify(invalidatedEntryIds)
  );
}

/** One account owner serializes each project/scope stream; durable CAS handles other pages. */
export class ResourceCatalogAcquisition {
  private readonly states = new Map<string, AcquisitionState>();
  private readonly operations = new Set<Promise<unknown>>();
  private closing = false;
  private epoch = 0;

  constructor(
    readonly accountId: string,
    private readonly metadata: ResourceMetadataStore,
    private readonly transport: ResourceCatalogTransport,
  ) {
    if (metadata.accountId !== accountId || transport.accountId !== accountId)
      throw new Error("Resource catalog account mismatch");
  }

  private state(projectId: string, scope: CatalogScope): AcquisitionState {
    const key = catalogProjectionKey(projectId, scope);
    let state = this.states.get(key);
    if (!state) {
      state = { hintedHighWater: 0n, inFlight: null };
      this.states.set(key, state);
    }
    return state;
  }

  private assertCurrent(epoch: number): void {
    if (this.closing || epoch !== this.epoch) throw new Error("Resource catalog is closing");
  }

  private assertResponseScope(requested: CatalogScope, received: CatalogScope): void {
    if (!catalogResponseMatchesRequest(this.accountId, requested, received))
      throw new Error("Resource catalog response scope mismatch");
  }

  private async install(
    projectId: string,
    before: ProjectResourceSnapshot,
    previous: ResourceCatalogCheckpoint | null,
    view: CatalogCacheView,
    fence: CatalogObservationFence,
    epoch: number,
  ): Promise<"committed" | "stale"> {
    let snapshot = before;
    for (let retry = 0; retry < 10; retry += 1) {
      this.assertCurrent(epoch);
      const plan = planCatalogInstallation({
        projectId,
        records: snapshot.records,
        previous,
        view,
        observedAfter: fence,
      });
      if (plan.resources.length === 0 && checkpointMatchesView(previous, view)) return "committed";
      const result = await this.metadata.commitCatalog({
        expectedRevision: previous?.revision ?? null,
        next: plan.checkpoint,
        resources: plan.resources,
      });
      this.assertCurrent(epoch);
      if (result === "committed") return result;
      snapshot = await this.metadata.readProject(projectId);
      this.assertCurrent(epoch);
      const current = checkpointFor(projectId, view.scope, snapshot);
      if ((current?.revision ?? null) !== (previous?.revision ?? null)) return "stale";
    }
    return "stale";
  }

  private async requestSnapshot(
    projectId: string,
    scope: CatalogScope,
    epoch: number,
    observedBefore?: ProjectResourceSnapshot,
  ): Promise<{ view: CatalogCacheView; committed: boolean }> {
    const before = observedBefore ?? (await this.metadata.readProject(projectId));
    this.assertCurrent(epoch);
    const previous = checkpointFor(projectId, scope, before);
    const fence = observationFence(before);
    const response = await this.transport.snapshot(projectId, scope);
    this.assertCurrent(epoch);
    this.assertResponseScope(scope, response.scope);
    const view = catalogViewFromSnapshot(response);
    const current = await this.metadata.readProject(projectId);
    this.assertCurrent(epoch);
    return {
      view,
      committed:
        (await this.install(projectId, current, previous, view, fence, epoch)) === "committed",
    };
  }

  private async drain(
    projectId: string,
    scope: CatalogScope,
    state: AcquisitionState,
    epoch: number,
  ): Promise<CatalogCacheView> {
    for (let page = 0; page < 100; page += 1) {
      const before = await this.metadata.readProject(projectId);
      this.assertCurrent(epoch);
      const previous = checkpointFor(projectId, scope, before);
      if (!previous) {
        const installed = await this.requestSnapshot(projectId, scope, epoch, before);
        if (!installed.committed) continue;
        if ((revision(installed.view.appliedRevision) ?? 0n) >= state.hintedHighWater)
          return installed.view;
        continue;
      }

      const current = catalogViewFromCheckpoint(previous);
      const fence = observationFence(before);
      const changes = await this.transport.changes(projectId, scope, current.cursor);
      this.assertCurrent(epoch);
      this.assertResponseScope(scope, changes.scope);
      if (changes.kind === "reset-required") {
        const installed = await this.requestSnapshot(projectId, scope, epoch, before);
        if (!installed.committed) continue;
        if ((revision(installed.view.appliedRevision) ?? 0n) >= state.hintedHighWater)
          return installed.view;
        continue;
      }
      const next = applyCatalogChanges(current, changes);
      if (!next) {
        const installed = await this.requestSnapshot(projectId, scope, epoch, before);
        if (!installed.committed) continue;
        if ((revision(installed.view.appliedRevision) ?? 0n) >= state.hintedHighWater)
          return installed.view;
        continue;
      }
      if ((await this.install(projectId, before, previous, next, fence, epoch)) === "stale")
        continue;
      if (changes.hasMore) continue;
      const applied = revision(next.appliedRevision);
      if (applied === null || applied >= state.hintedHighWater) return next;
      if (next.appliedRevision === current.appliedRevision) return next;
    }
    throw new Error("Resource catalog did not converge");
  }

  acquire(projectId: string, scope: CatalogScope): Promise<CatalogCacheView> {
    if (this.closing) return Promise.reject(new Error("Resource catalog is closing"));
    if (!catalogRequestBelongsToProject(projectId, scope))
      return Promise.reject(new Error("Resource catalog request scope mismatch"));
    const state = this.state(projectId, scope);
    if (state.inFlight) return state.inFlight;
    const epoch = this.epoch;
    const operation = this.drain(projectId, scope, state, epoch);
    const inFlight = operation.finally(() => {
      this.operations.delete(operation);
      if (state.inFlight === inFlight) state.inFlight = null;
    });
    this.operations.add(operation);
    state.inFlight = inFlight;
    return inFlight;
  }

  hint(projectId: string, scope: CatalogScope, headRevision: string): Promise<CatalogCacheView> {
    const state = this.state(projectId, scope);
    const head = revision(headRevision);
    if (head !== null && head > state.hintedHighWater) state.hintedHighWater = head;
    return this.acquire(projectId, scope);
  }

  beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.epoch += 1;
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.operations]);
    this.states.clear();
  }
}
