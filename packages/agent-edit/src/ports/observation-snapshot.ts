// Durable authority for document evidence actually rendered into a model request.

export interface CanonicalBlockIdentity {
  clientID: number;
  clock: number;
}

export interface ObservationKey extends CanonicalBlockIdentity {
  documentId: string;
}

export type ObservationValue =
  | { kind: "rendered"; digest: string }
  | { kind: "explicit_deletion"; capturedBody: string };

export interface ObservationEntry extends ObservationKey {
  value: ObservationValue;
}

export interface ObservationSnapshot {
  responseId: string;
  entries: readonly ObservationEntry[];
}

export interface ObservationSnapshotStore {
  seal(snapshot: ObservationSnapshot): Promise<void>;
  load(responseId: string): Promise<ObservationSnapshot | null>;
}
