// Builds request-local observation candidates and seals them only to successful responses.

import type {
  ObservationEntry,
  ObservationKey,
  ObservationSnapshot,
  ObservationSnapshotStore,
  ObservationValue,
} from "./ports/observation-snapshot.js";

export interface RenderedObservation extends ObservationKey {
  /** Exact canonical block rendering placed in the gateway request. */
  renderedContent: string;
}

export interface ExplicitDeletionObservation extends ObservationKey {
  /** Exact deleted body placed in the gateway request. */
  capturedBody: string;
}

export interface ObservationCandidate {
  readonly requestId: string;
  observeRendered(input: RenderedObservation): void;
  observeExplicitDeletion(input: ExplicitDeletionObservation): void;
  /** Omitted and overflowed bodies deliberately earn no entry. */
  omit(input: ObservationKey, reason: "omitted" | "sync_overflow"): void;
}

export interface ObservationAuthority {
  beginRequest(requestId: string): ObservationCandidate;
  sealSuccessfulResponse(responseId: string, candidate: ObservationCandidate): Promise<void>;
  lookup(responseId: string, key: ObservationKey): Promise<ObservationValue | null>;
  load(responseId: string): Promise<ObservationSnapshot | null>;
}

export function createObservationAuthority(deps: {
  store: ObservationSnapshotStore;
  digestRenderedContent(content: string): string;
}): ObservationAuthority {
  return {
    beginRequest(requestId) {
      return new Candidate(requestId, deps.digestRenderedContent);
    },
    async sealSuccessfulResponse(responseId, candidate) {
      if (!(candidate instanceof Candidate)) {
        throw new TypeError("Observation candidate was not created by this authority");
      }
      await deps.store.seal({ responseId, entries: candidate.freeze() });
    },
    async lookup(responseId, key) {
      const snapshot = await deps.store.load(responseId);
      if (!snapshot) return null;
      return snapshot.entries.find((entry) => sameKey(entry, key))?.value ?? null;
    },
    load(responseId) {
      return deps.store.load(responseId);
    },
  };
}

class Candidate implements ObservationCandidate {
  readonly #entries = new Map<string, ObservationEntry>();
  #sealed = false;

  constructor(
    readonly requestId: string,
    private readonly digest: (content: string) => string,
  ) {}

  observeRendered(input: RenderedObservation): void {
    this.set(input, { kind: "rendered", digest: this.digest(input.renderedContent) });
  }

  observeExplicitDeletion(input: ExplicitDeletionObservation): void {
    this.set(input, { kind: "explicit_deletion", capturedBody: input.capturedBody });
  }

  omit(_input: ObservationKey, _reason: "omitted" | "sync_overflow"): void {
    this.assertOpen();
  }

  freeze(): readonly ObservationEntry[] {
    this.assertOpen();
    this.#sealed = true;
    return Object.freeze(
      [...this.#entries.values()]
        .sort(compareEntries)
        .map((entry) => Object.freeze({ ...entry, value: Object.freeze({ ...entry.value }) })),
    );
  }

  private set(key: ObservationKey, value: ObservationValue): void {
    this.assertOpen();
    assertIdentity(key);
    this.#entries.set(entryKey(key), { ...key, value });
  }

  private assertOpen(): void {
    if (this.#sealed) throw new Error("Observation candidate is already sealed");
  }
}

function assertIdentity(key: ObservationKey): void {
  if (!Number.isSafeInteger(key.clientID) || key.clientID < 0) {
    throw new TypeError("clientID must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(key.clock) || key.clock < 0) {
    throw new TypeError("clock must be a non-negative safe integer");
  }
}

function entryKey(key: ObservationKey): string {
  return `${key.documentId.length}:${key.documentId}:${key.clientID}:${key.clock}`;
}

function sameKey(left: ObservationKey, right: ObservationKey): boolean {
  return (
    left.documentId === right.documentId &&
    left.clientID === right.clientID &&
    left.clock === right.clock
  );
}

function compareEntries(left: ObservationEntry, right: ObservationEntry): number {
  return (
    left.documentId.localeCompare(right.documentId) ||
    left.clientID - right.clientID ||
    left.clock - right.clock
  );
}
