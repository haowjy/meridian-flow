/** Journal admission for by-identity fill and prepend, sharing the socket admission lock. */
import type {
  JournalSnapshot,
  PersistedUpdate,
  UpdateMeta,
} from "@meridian/agent-edit/integration";

export interface DocumentLandingJournal {
  /**
   * Prepare against a locked durable cut, then append atomically. `onlySeed`
   * refuses any admission after initialization, even if history was compacted.
   * Null means refused; publication belongs to the caller's commit boundary.
   */
  admitDocumentLanding(
    documentId: string,
    onlySeed: boolean,
    prepare: (snapshot: JournalSnapshot) => Promise<{ update: Uint8Array; meta: UpdateMeta }>,
  ): Promise<PersistedUpdate | null>;
}
