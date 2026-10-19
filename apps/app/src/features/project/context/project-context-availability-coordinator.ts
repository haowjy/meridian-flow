/** Account-owned project-final identity coordinator and deterministic drain core. */
import type {
  AvailabilityCommandId,
  AvailabilityGeneration,
  CatalogFileEntry,
  DocumentRemovalRecord,
  ProjectContextAuthority,
  ProjectContextIdentityLookupResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";

export type ProjectDocumentAvailabilityCommand =
  | {
      kind: "available";
      commandId: AvailabilityCommandId;
      projectId: string;
      document: CatalogFileEntry;
      generation: AvailabilityGeneration;
    }
  | {
      kind: "terminal-remove";
      commandId: AvailabilityCommandId;
      projectId: string;
      documentId: string;
      generation: AvailabilityGeneration;
      /** Namespace version that proved the deletion; the local terminal keeps it. */
      deletionVersion: string | null;
      cause: "document-deleted";
      /** Who removed it and why; absent when the deletion was learned without a lookup. */
      removal?: DocumentRemovalRecord;
    }
  | {
      kind: "authority-revoke";
      commandId: AvailabilityCommandId;
      projectId: string;
      documentId: string;
      generation: AvailabilityGeneration;
      authority: ProjectContextAuthority;
      cause: "authority-unavailable" | "no-longer-visible";
    };

type Lookup = (
  projectId: string,
  documentIds: readonly string[],
) => Promise<ProjectContextIdentityLookupResult>;

export type AvailabilityWatchRecord = Readonly<{ documentId: string; sourceWorkId?: string }>;
type AggregatedWatchRecord = { documentId: string; sourceWorkIds: Set<string> };
type ProjectState = {
  leases: number;
  watches: Map<string, ReadonlyMap<string, AvailabilityWatchRecord>>;
  authorizationObservers: Map<
    string,
    { records: ReadonlySet<string>; observer: AuthorizationLossObserver }
  >;
  requestGeneration: Map<string, number>;
  highestAuthorityGeneration: Map<string, bigint>;
  admittedAuthority: Map<string, ProjectContextAuthority>;
  inFlight: number;
  slotWaiters: Array<() => void>;
};

export type AuthorizationLoss = Readonly<{
  projectId: string;
  documentId: string;
  generation: AvailabilityGeneration;
  reason: "authority-unavailable" | "not-visible";
}>;
export type AuthorizationLossObserver = (loss: AuthorizationLoss) => void;

export type ProjectAvailabilityLease = {
  watch(producer: string, records: readonly AvailabilityWatchRecord[]): void;
  observeAuthorizationLoss(
    producer: string,
    records: readonly AvailabilityWatchRecord[],
    observer: AuthorizationLossObserver,
  ): void;
  release(): void;
};

/**
 * What the server last said about one document, for explaining a removal.
 * `removed` carries its record (null: the server keeps none, e.g. its source
 * or Work went rather than the document itself). `available` can precede the
 * commit of a delete the shared local replica already applied, so it is not
 * final while someone asks. `lost`: an authority loss, explained elsewhere.
 * `unresolved`: the last lookup failed; focus, online and the poll retry it.
 */
export type RemovalAnswer =
  | { kind: "removed"; record: DocumentRemovalRecord | null }
  | { kind: "available" | "lost" | "unresolved" };

/** One document's subscribable answer; subscribing asks for it (`removalRecord`). */
export type RemovalRecordHandle = {
  get(): RemovalAnswer | undefined;
  subscribe(listener: () => void): () => void;
};

type RemovalAsks = {
  lease: ProjectAvailabilityLease;
  counts: Map<string, number>;
  /** Asked documents not yet looked up for this ask. */
  unasked: Set<string>;
  scheduled: boolean;
};

export type ProjectDocumentOpenResolution =
  | ProjectContextIdentityResolution
  | { kind: "failed" | "malformed" };

const MAX_IDS = 128;
const MAX_ATTEMPTS = 2;

function authorityGeneration(resolution: ProjectContextIdentityResolution): string {
  return resolution.kind === "not-visible" || resolution.kind === "indeterminate"
    ? resolution.checkedGeneration
    : resolution.generation;
}

function removalKey(projectId: string, documentId: string): string {
  return JSON.stringify([projectId, documentId]);
}

function commandId(
  kind: ProjectDocumentAvailabilityCommand["kind"],
  projectId: string,
  documentId: string,
  generation: string,
): AvailabilityCommandId {
  return `availability/v1/${kind}/${projectId}/${documentId}/${generation}`;
}

export class ProjectContextAvailabilityCoordinator {
  private readonly projects = new Map<string, ProjectState>();
  private nextLeaseId = 0;
  private readonly pendingOpens = new Map<string, Promise<ProjectDocumentOpenResolution>>();
  /**
   * Removal answers by `[projectId, documentId]`: every `removed` one, and any
   * answer for an asked document. A later resolution of the same document
   * replaces it, whichever watch, open or poll brought it.
   */
  private readonly removalAnswers = new Map<string, RemovalAnswer>();
  private readonly removalListeners = new Map<string, Set<() => void>>();
  private readonly removalAsks = new Map<string, RemovalAsks>();

  constructor(
    private readonly dependencies: {
      lookup: Lookup;
      apply(commands: readonly ProjectDocumentAvailabilityCommand[]): unknown;
      repairProjectCatalog(projectId: string): Promise<void>;
      retryDelayMs?: number;
      onIndeterminate?: (projectId: string, documentId: string) => void;
    },
  ) {}

  attachProject(projectId: string): ProjectAvailabilityLease {
    const state = this.project(projectId);
    state.leases += 1;
    const prefix = `lease:${++this.nextLeaseId}:`;
    let held = true;
    return {
      watch: (producer, records) => {
        if (!held) return;
        const before = new Set(this.watchedRecords(state).map((record) => record.documentId));
        state.watches.set(
          `${prefix}${producer}`,
          new Map(records.map((record) => [record.documentId, Object.freeze({ ...record })])),
        );
        this.fenceLostWatches(state, before);
      },
      observeAuthorizationLoss: (producer, records, observer) => {
        if (!held) return;
        const key = `${prefix}authorization:${producer}`;
        const before = new Set(this.watchedRecords(state).map((record) => record.documentId));
        state.watches.set(
          key,
          new Map(records.map((record) => [record.documentId, Object.freeze({ ...record })])),
        );
        state.authorizationObservers.set(key, {
          records: new Set(records.map((record) => record.documentId)),
          observer,
        });
        this.fenceLostWatches(state, before);
        void this.recheck(
          projectId,
          records.map((record) => record.documentId),
        );
      },
      release: () => {
        if (!held) return;
        held = false;
        const before = new Set(this.watchedRecords(state).map((record) => record.documentId));
        for (const key of state.watches.keys())
          if (key.startsWith(prefix)) {
            state.watches.delete(key);
            state.authorizationObservers.delete(key);
          }
        this.fenceLostWatches(state, before);
        state.leases -= 1;
        if (state.leases === 0) this.projects.delete(projectId);
      },
    };
  }

  async coldScopeHint(projectId: string, workId: string): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    const ids = this.watchedRecords(state)
      .filter((record) => record.sourceWorkIds.has(workId))
      .map((record) => record.documentId);
    if (ids.length > 0) await this.recheck(projectId, ids);
  }

  async recheckWatchedProjects(): Promise<void> {
    await Promise.all([...this.projects.keys()].sort().map((projectId) => this.recheck(projectId)));
  }

  watchedDocumentIds(projectId: string): string[] {
    const state = this.projects.get(projectId);
    return state
      ? this.watchedRecords(state)
          .map((record) => record.documentId)
          .sort()
      : [];
  }

  /** Admit a committed server delete directly into the canonical terminal batch. */
  async acceptCommittedDelete(input: {
    projectId: string;
    deletedDocumentIds: readonly string[];
    generation: AvailabilityGeneration;
    deletionVersion: string | null;
  }): Promise<void> {
    const state = this.project(input.projectId);
    const generation = BigInt(input.generation);
    const staged = [...new Set(input.deletedDocumentIds)]
      .sort()
      .filter(
        (documentId) => generation > (state.highestAuthorityGeneration.get(documentId) ?? -1n),
      )
      .map((documentId) => ({
        documentId,
        requestGeneration: (state.requestGeneration.get(documentId) ?? 0) + 1,
        command: {
          kind: "terminal-remove" as const,
          projectId: input.projectId,
          documentId,
          generation: input.generation,
          deletionVersion: input.deletionVersion,
          cause: "document-deleted" as const,
          commandId: commandId("terminal-remove", input.projectId, documentId, input.generation),
        },
      }));
    if (staged.length === 0) return;

    await this.dependencies.apply(staged.map(({ command }) => command));
    for (const candidate of staged) {
      state.requestGeneration.set(candidate.documentId, candidate.requestGeneration);
      state.highestAuthorityGeneration.set(candidate.documentId, generation);
      state.admittedAuthority.delete(candidate.documentId);
    }
  }

  /** One exact-ID authority resolution with its own short-lived project lease. */
  resolveForOpen(projectId: string, documentId: string): Promise<ProjectDocumentOpenResolution> {
    const key = JSON.stringify([projectId, documentId]);
    const pending = this.pendingOpens.get(key);
    if (pending) return pending;
    const opening = this.resolveOpen(projectId, documentId).finally(() =>
      this.pendingOpens.delete(key),
    );
    this.pendingOpens.set(key, opening);
    return opening;
  }

  private async resolveOpen(
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentOpenResolution> {
    const lease = this.attachProject(projectId);
    // The departing view may release its watch while this explicit open is awaiting authority.
    lease.watch("open", [{ documentId }]);
    const state = this.project(projectId);
    const requestGeneration = (state.requestGeneration.get(documentId) ?? 0) + 1;
    state.requestGeneration.set(documentId, requestGeneration);
    try {
      let response: ProjectContextIdentityLookupResult;
      try {
        response = await this.withLookupSlot(state, () =>
          this.dependencies.lookup(projectId, [documentId]),
        );
      } catch {
        this.learnUnresolved(projectId, [documentId]);
        return { kind: "failed" };
      }
      if (
        state.requestGeneration.get(documentId) !== requestGeneration ||
        response.resolutions.length !== 1 ||
        response.resolutions[0]?.documentId !== documentId
      ) {
        return { kind: "malformed" };
      }
      const resolution = response.resolutions[0];
      const generation = BigInt(authorityGeneration(resolution));
      if (generation < (state.highestAuthorityGeneration.get(documentId) ?? -1n))
        return { kind: "malformed" };
      // Learned before the commands apply, so whatever they close reads the answer at once.
      this.learnRemoval(projectId, resolution);
      const command = this.classify(projectId, resolution, state);
      if (command) await this.dependencies.apply([command]);
      if (state.requestGeneration.get(documentId) !== requestGeneration)
        return { kind: "malformed" };
      state.highestAuthorityGeneration.set(documentId, generation);
      if (resolution.kind === "available") {
        state.admittedAuthority.set(documentId, resolution.authority);
      } else if (
        resolution.kind === "deleted" ||
        resolution.kind === "authority-unavailable" ||
        (resolution.kind === "not-visible" && command)
      ) {
        state.admittedAuthority.delete(documentId);
      }
      this.emitAuthorizationLoss(projectId, state, resolution);
      return resolution;
    } finally {
      lease.release();
    }
  }

  async recheck(projectId: string, candidateIds?: readonly string[]): Promise<void> {
    const state = this.projects.get(projectId);
    if (!state) return;
    const watched = new Set(this.watchedRecords(state).map((record) => record.documentId));
    const ids = [...new Set(candidateIds ?? [...watched])].filter((id) => watched.has(id)).sort();
    if (ids.length === 0) return;

    const localGenerations = new Map<string, number>();
    for (const documentId of ids) {
      const next = (state.requestGeneration.get(documentId) ?? 0) + 1;
      state.requestGeneration.set(documentId, next);
      localGenerations.set(documentId, next);
    }

    const initial = await this.lookupChunks(projectId, ids, state);
    const candidates = new Map<string, ProjectContextIdentityResolution>();
    const unresolved = new Set(initial.unresolved);
    const indeterminate: string[] = [];
    for (const [documentId, resolution] of initial.resolutions) {
      if (state.requestGeneration.get(documentId) !== localGenerations.get(documentId)) continue;
      if (resolution.kind === "indeterminate") indeterminate.push(documentId);
      else candidates.set(documentId, resolution);
    }

    if (indeterminate.length > 0) {
      for (const documentId of indeterminate)
        this.dependencies.onIndeterminate?.(projectId, documentId);
      try {
        await this.dependencies.repairProjectCatalog(projectId);
      } catch {
        for (const documentId of indeterminate) unresolved.add(documentId);
      }
      const stillCurrent = indeterminate.filter(
        (documentId) =>
          state.requestGeneration.get(documentId) === localGenerations.get(documentId),
      );
      if (stillCurrent.length > 0 && !stillCurrent.some((id) => unresolved.has(id))) {
        const repaired = await this.lookupChunks(projectId, stillCurrent, state);
        for (const documentId of repaired.unresolved) unresolved.add(documentId);
        for (const [documentId, resolution] of repaired.resolutions) {
          if (state.requestGeneration.get(documentId) !== localGenerations.get(documentId))
            continue;
          candidates.set(documentId, resolution);
        }
      }
    }

    if (this.projects.get(projectId) !== state || state.leases === 0) return;
    const liveWatched = new Set(this.watchedRecords(state).map((record) => record.documentId));
    const isCurrent = (documentId: string) =>
      liveWatched.has(documentId) &&
      state.requestGeneration.get(documentId) === localGenerations.get(documentId);
    this.learnUnresolved(projectId, [...unresolved].filter(isCurrent));
    if ([...unresolved].some(isCurrent)) return;

    const committed: Array<{
      documentId: string;
      resolution: ProjectContextIdentityResolution;
      generation: bigint;
      command: ProjectDocumentAvailabilityCommand | null;
    }> = [];
    for (const documentId of ids) {
      if (!isCurrent(documentId)) continue;
      const resolution = candidates.get(documentId);
      if (!resolution) continue;
      const generation = BigInt(authorityGeneration(resolution));
      if (generation < (state.highestAuthorityGeneration.get(documentId) ?? -1n)) continue;
      this.learnRemoval(projectId, resolution);
      committed.push({
        documentId,
        resolution,
        generation,
        command: this.classify(projectId, resolution, state),
      });
    }
    if (committed.length === 0) return;
    const commands = committed.flatMap(({ command }) => (command ? [command] : []));
    commands.sort((left, right) => left.commandId.localeCompare(right.commandId));
    await this.dependencies.apply(commands);

    for (const candidate of committed) {
      if (!isCurrent(candidate.documentId)) continue;
      if (
        candidate.generation < (state.highestAuthorityGeneration.get(candidate.documentId) ?? -1n)
      )
        continue;
      state.highestAuthorityGeneration.set(candidate.documentId, candidate.generation);
      if (candidate.resolution.kind === "available") {
        state.admittedAuthority.set(candidate.documentId, candidate.resolution.authority);
      } else if (
        candidate.resolution.kind === "deleted" ||
        candidate.resolution.kind === "authority-unavailable" ||
        (candidate.resolution.kind === "not-visible" && candidate.command)
      ) {
        state.admittedAuthority.delete(candidate.documentId);
      }
      this.emitAuthorizationLoss(projectId, state, candidate.resolution);
    }
  }

  /**
   * One document's removal answer. While subscribed and not yet `removed` or
   * `lost`, the document is watched, so focus, online and the poll keep asking;
   * the first subscription asks at once unless an answer or an open is pending.
   */
  removalRecord(projectId: string, documentId: string): RemovalRecordHandle {
    const key = removalKey(projectId, documentId);
    return {
      get: () => this.removalAnswers.get(key),
      subscribe: (listener) => {
        const listeners = this.removalListeners.get(key) ?? new Set();
        listeners.add(listener);
        this.removalListeners.set(key, listeners);
        this.ask(projectId, documentId);
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          listeners.delete(listener);
          if (listeners.size === 0) this.removalListeners.delete(key);
          this.unask(projectId, documentId);
        };
      },
    };
  }

  private ask(projectId: string, documentId: string): void {
    let asks = this.removalAsks.get(projectId);
    if (!asks) {
      asks = {
        lease: this.attachProject(projectId),
        counts: new Map(),
        unasked: new Set(),
        scheduled: false,
      };
      this.removalAsks.set(projectId, asks);
    }
    const count = asks.counts.get(documentId) ?? 0;
    asks.counts.set(documentId, count + 1);
    if (count > 0) return;
    if (!this.removalAnswers.has(removalKey(projectId, documentId))) asks.unasked.add(documentId);
    this.watchAsked(projectId, asks);
  }

  private unask(projectId: string, documentId: string): void {
    const asks = this.removalAsks.get(projectId);
    const count = asks?.counts.get(documentId);
    if (!asks || count === undefined) return;
    if (count > 1) {
      asks.counts.set(documentId, count - 1);
      return;
    }
    asks.counts.delete(documentId);
    asks.unasked.delete(documentId);
    const key = removalKey(projectId, documentId);
    // Only `removed` outlives its asks; anything else is stale once no one waits on it.
    if (this.removalAnswers.get(key)?.kind !== "removed") this.removalAnswers.delete(key);
    if (asks.counts.size > 0) {
      this.watchAsked(projectId, asks);
      return;
    }
    this.removalAsks.delete(projectId);
    asks.lease.release();
  }

  /** Watches asked documents still waiting, and looks up new asks once, batched. */
  private watchAsked(projectId: string, asks: RemovalAsks): void {
    if (asks.scheduled) return;
    asks.scheduled = true;
    queueMicrotask(() => {
      asks.scheduled = false;
      if (this.removalAsks.get(projectId) !== asks) return;
      asks.lease.watch(
        "removal-records",
        [...asks.counts.keys()].flatMap((documentId) => {
          const answer = this.removalAnswers.get(removalKey(projectId, documentId));
          return answer?.kind === "removed" || answer?.kind === "lost" ? [] : [{ documentId }];
        }),
      );
      // An open in flight answers for itself; a second lookup would fence it.
      const lookup = [...asks.unasked].filter(
        (documentId) =>
          !this.removalAnswers.has(removalKey(projectId, documentId)) &&
          !this.pendingOpens.has(JSON.stringify([projectId, documentId])),
      );
      asks.unasked.clear();
      if (lookup.length > 0) void this.recheck(projectId, lookup);
    });
  }

  private learnRemoval(projectId: string, resolution: ProjectContextIdentityResolution): void {
    if (resolution.kind === "indeterminate") return;
    const answer: RemovalAnswer =
      resolution.kind === "deleted"
        ? { kind: "removed", record: resolution.removal ?? null }
        : { kind: resolution.kind === "available" ? "available" : "lost" };
    this.setRemovalAnswer(projectId, resolution.documentId, answer);
  }

  private learnUnresolved(projectId: string, documentIds: readonly string[]): void {
    for (const documentId of documentIds)
      if (!this.removalAnswers.has(removalKey(projectId, documentId)))
        this.setRemovalAnswer(projectId, documentId, { kind: "unresolved" });
  }

  private setRemovalAnswer(projectId: string, documentId: string, answer: RemovalAnswer): void {
    const key = removalKey(projectId, documentId);
    const asks = this.removalAsks.get(projectId);
    const asked = asks?.counts.has(documentId) ?? false;
    const prior = this.removalAnswers.get(key);
    if (!asked && answer.kind !== "removed") {
      if (!prior) return;
      this.removalAnswers.delete(key);
    } else {
      if (prior && JSON.stringify(prior) === JSON.stringify(answer)) return;
      this.removalAnswers.set(key, answer);
    }
    if (asks && asked) this.watchAsked(projectId, asks);
    for (const listener of [...(this.removalListeners.get(key) ?? [])]) listener();
  }

  private emitAuthorizationLoss(
    projectId: string,
    state: ProjectState,
    resolution: ProjectContextIdentityResolution,
  ): void {
    if (resolution.kind !== "authority-unavailable" && resolution.kind !== "not-visible") return;
    const loss: AuthorizationLoss = {
      projectId,
      documentId: resolution.documentId,
      generation:
        resolution.kind === "not-visible" ? resolution.checkedGeneration : resolution.generation,
      reason: resolution.kind,
    };
    for (const { records, observer } of state.authorizationObservers.values()) {
      if (records.has(resolution.documentId)) observer(loss);
    }
  }

  private async lookupChunks(
    projectId: string,
    documentIds: readonly string[],
    state: ProjectState,
  ): Promise<{
    resolutions: Map<string, ProjectContextIdentityResolution>;
    unresolved: Set<string>;
  }> {
    const chunks: string[][] = [];
    for (let index = 0; index < documentIds.length; index += MAX_IDS)
      chunks.push(documentIds.slice(index, index + MAX_IDS));
    const resolutions = new Map<string, ProjectContextIdentityResolution>();
    const unresolved = new Set<string>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        if (!chunk) return;
        let response: ProjectContextIdentityLookupResult | null = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS && !response; attempt += 1) {
          try {
            response = await this.withLookupSlot(state, () =>
              this.dependencies.lookup(projectId, chunk),
            );
          } catch {
            if (attempt + 1 < MAX_ATTEMPTS && this.dependencies.retryDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, this.dependencies.retryDelayMs));
            }
          }
        }
        if (!response) {
          for (const documentId of chunk) unresolved.add(documentId);
          continue;
        }
        const byId = new Map(response.resolutions.map((item) => [item.documentId, item]));
        if (byId.size !== chunk.length || chunk.some((id) => !byId.has(id))) {
          for (const documentId of chunk) unresolved.add(documentId);
          continue;
        }
        for (const documentId of chunk) {
          const resolution = byId.get(documentId);
          if (resolution) resolutions.set(documentId, resolution);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return { resolutions, unresolved };
  }

  private classify(
    projectId: string,
    resolution: ProjectContextIdentityResolution,
    state: ProjectState,
  ): ProjectDocumentAvailabilityCommand | null {
    const documentId = resolution.documentId;
    if (resolution.kind === "available") {
      return {
        kind: "available",
        projectId,
        document: resolution.entry,
        generation: resolution.generation,
        commandId: commandId("available", projectId, documentId, resolution.generation),
      };
    }
    if (resolution.kind === "deleted") {
      return {
        kind: "terminal-remove",
        projectId,
        documentId,
        generation: resolution.generation,
        deletionVersion: resolution.observationVersion,
        cause: "document-deleted",
        ...(resolution.removal ? { removal: resolution.removal } : {}),
        commandId: commandId("terminal-remove", projectId, documentId, resolution.generation),
      };
    }
    if (resolution.kind === "authority-unavailable") {
      return {
        kind: "authority-revoke",
        projectId,
        documentId,
        generation: resolution.generation,
        authority: resolution.authority,
        cause: "authority-unavailable",
        commandId: commandId("authority-revoke", projectId, documentId, resolution.generation),
      };
    }
    if (resolution.kind === "not-visible") {
      const authority = state.admittedAuthority.get(documentId);
      if (!authority) return null;
      return {
        kind: "authority-revoke",
        projectId,
        documentId,
        generation: resolution.checkedGeneration,
        authority,
        cause: "no-longer-visible",
        commandId: commandId(
          "authority-revoke",
          projectId,
          documentId,
          resolution.checkedGeneration,
        ),
      };
    }
    return null;
  }

  private watchedRecords(state: ProjectState): AggregatedWatchRecord[] {
    const records = new Map<string, AggregatedWatchRecord>();
    for (const watch of state.watches.values()) {
      for (const record of watch.values()) {
        const aggregate = records.get(record.documentId) ?? {
          documentId: record.documentId,
          sourceWorkIds: new Set<string>(),
        };
        if (record.sourceWorkId) aggregate.sourceWorkIds.add(record.sourceWorkId);
        const admitted = state.admittedAuthority.get(record.documentId);
        if (admitted?.kind === "work") aggregate.sourceWorkIds.add(admitted.workId);
        records.set(record.documentId, aggregate);
      }
    }
    return [...records.values()];
  }

  private fenceLostWatches(state: ProjectState, before: ReadonlySet<string>): void {
    const after = new Set(this.watchedRecords(state).map((record) => record.documentId));
    for (const documentId of before) {
      if (!after.has(documentId)) {
        state.requestGeneration.set(documentId, (state.requestGeneration.get(documentId) ?? 0) + 1);
      }
    }
  }

  private async withLookupSlot<T>(state: ProjectState, run: () => Promise<T>): Promise<T> {
    if (state.inFlight >= 2) await new Promise<void>((resolve) => state.slotWaiters.push(resolve));
    state.inFlight += 1;
    try {
      return await run();
    } finally {
      state.inFlight -= 1;
      state.slotWaiters.shift()?.();
    }
  }

  private project(projectId: string): ProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        leases: 0,
        watches: new Map(),
        authorizationObservers: new Map(),
        requestGeneration: new Map(),
        highestAuthorityGeneration: new Map(),
        admittedAuthority: new Map(),
        inFlight: 0,
        slotWaiters: [],
      };
      this.projects.set(projectId, state);
    }
    return state;
  }
}
