import type { NormalizedTrail, TrailChangeV1 } from "../trail-read-kernel.js";

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
