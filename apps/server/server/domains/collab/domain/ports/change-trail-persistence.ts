import type {
  NormalizedTrail,
  RawTrailChange,
  TrailChangeV1,
  TrailOwner,
} from "../trail-read-kernel.js";

export type DurableTrailRecord = {
  documentId: string;
  documentTitle: string;
  receiptId: string;
  threadIds: readonly string[];
  journalOwners: readonly (TrailOwner | null)[];
  changes: readonly RawTrailChange[];
};

export type ChangeTrailPersistence = {
  record(input: {
    trails: readonly NormalizedTrail[];
    documentTitles: ReadonlyMap<string, string>;
  }): Promise<readonly CommittedChangeTrailProjection[]>;
};

export type CommittedChangeTrailProjection = {
  trailId: string;
  owner: NormalizedTrail["owner"];
  documentId: string;
  projectionRevision: number;
  changes: Array<TrailChangeV1 & { admittedByUserId: string | null }>;
};
