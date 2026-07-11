/** Domain port for atomically recording normalized change trails. */

import type { NoticeInput } from "../../../notices/index.js";
import type { NormalizedTrail, RawTrailChange, TrailOwner } from "../trail-read-kernel.js";

export type DurableTrailRecord = {
  documentId: string;
  documentTitle: string;
  receiptId: string;
  threadIds: readonly string[];
  journalOwners: readonly (TrailOwner | null)[];
  changes: readonly RawTrailChange[];
  transactionalNotice?: NoticeInput;
};

export type ChangeTrailPersistence = {
  record(input: {
    trails: readonly NormalizedTrail[];
    documentTitles: ReadonlyMap<string, string>;
  }): Promise<void>;
  reopenOwners(owners: readonly NormalizedTrail["owner"][]): Promise<void>;
};
