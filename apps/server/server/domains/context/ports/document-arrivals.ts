/**
 * Arrival hooks for ahead-ref settlement (contract §9.3–9.4). A document arrives when it
 * becomes live at an address: tracked create, upload, move-in, Work restore, or Apply.
 */
import type { DocumentId } from "@meridian/contracts/runtime";

export interface DocumentArrivals {
  /**
   * Namespace keys of the sources these documents occupy, sorted, namespace only. For arrivals
   * that are not authored writes (Apply, Work restore): after Work locks, before holder locks.
   */
  lockNamespaces(documentIds: readonly DocumentId[]): Promise<void>;
  /**
   * Inside the caller's transaction, which already holds every arrival's namespace key. Settles
   * against the transaction's current tree; draft-only and deleted rows are not arrivals.
   */
  settle(documentIds: readonly DocumentId[]): Promise<number>;
}
