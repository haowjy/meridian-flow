/** Domain port for atomically recording normalized change trails. */
import type { NormalizedTrail } from "../trail-read-kernel.js";

export type ChangeTrailPersistence = {
  record(input: {
    trails: readonly NormalizedTrail[];
    documentTitles: ReadonlyMap<string, string>;
  }): Promise<void>;
};
