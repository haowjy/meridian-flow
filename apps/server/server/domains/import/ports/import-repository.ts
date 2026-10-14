/** Durable selection and receipt storage. Mutations join the caller's import-row transaction. */
import type {
  ImportCounts,
  ImportEntryReason,
  ImportEntryState,
  ImportSelection,
  ImportState,
  ImportSummary,
  ImportUnreadableReason,
} from "@meridian/contracts";
import type { ImportMaintenanceCutoffs } from "../domain/maintenance-policy.js";
import type { ImportPlacement } from "../domain/placement.js";
import type { FileReceipt } from "../domain/receipt.js";
export type ImportRoot = ImportSelection["roots"][number] & { id: string | null; created: boolean };
export interface ImportRecord {
  id: string;
  projectId: string | null;
  userId: string;
  destinationUri: string;
  folderId: string | null;
  roots: ImportRoot[];
  placement: ImportPlacement | null;
  placementGeneration: number;
  fingerprint: string;
  state: ImportState;
  counts: ImportCounts;
  createdAt: Date;
  lastActivityAt: Date;
  leaseToken: string | null;
  leaseUntil: Date | null;
  claimsWithoutProgress: number;
  fellBack: boolean;
  reason: ImportSummary["reason"];
  revealedAt: Date | null;
  finishedAt: Date | null;
  acknowledgedAt: Date | null;
  objectsSweptAt: Date | null;
  finalSweepAt: Date | null;
}
export interface ImportEntrySelection {
  rootId: number;
  path: string;
  size: number;
  modifiedAt: number;
  reasonParams?: { readReason: ImportUnreadableReason };
}
interface ImportEntryBase {
  id: string;
  importId: string;
  ordinal: number;
  selection: ImportEntrySelection;
  state: ImportEntryState;
  reason: ImportEntryReason | null;
  convertedKey: string | null;
}
export type ImportEntry = ImportEntryBase &
  (
    | { kind: "file"; entryId: number; receipt: FileReceipt | null }
    | { kind: "folder"; entryId: null; receipt: null }
    | { kind: "unreadable"; entryId: number; receipt: null }
  );
export type ImportPatch = Partial<
  Omit<ImportRecord, "id" | "projectId" | "userId" | "fingerprint" | "createdAt">
>;
export type ImportEntryPatch = Partial<
  Pick<ImportEntry, "state" | "reason" | "convertedKey" | "receipt">
>;
export interface ImportRepository {
  transaction<T>(run: () => Promise<T>): Promise<T>;
  lockUser(userId: string): Promise<void>;
  lockIdentity(importId: string): Promise<void>;
  now(): Promise<Date>;
  read(id: string): Promise<ImportRecord | null>;
  lock(id: string): Promise<ImportRecord | null>;
  insert(record: ImportRecord, entries: ImportEntry[]): Promise<void>;
  update(id: string, patch: ImportPatch): Promise<void>;
  entries(id: string): Promise<ImportEntry[]>;
  fileEntries(
    importId: string,
    entryIds: number[],
  ): Promise<Extract<ImportEntry, { kind: "file" }>[]>;
  updateEntries(
    importId: string,
    patches: { id: string; patch: ImportEntryPatch }[],
  ): Promise<void>;
  transitionEntries(
    importId: string,
    from: ImportEntryState[],
    patch: Pick<ImportEntryPatch, "state" | "reason">,
    ids?: string[],
  ): Promise<void>;
  skipEntries(id: string, states: ImportEntryState[], reason: ImportEntryReason): Promise<void>;
  refreshCounts(id: string): Promise<ImportCounts>;
  hasAwaiting(id: string): Promise<boolean>;
  listOpen(userId: string): Promise<ImportRecord[]>;
  countOpen(userId: string): Promise<number>;
  waiting(record: ImportRecord): Promise<boolean>;
  maintenanceCandidates(limit: number, cutoffs: ImportMaintenanceCutoffs): Promise<ImportRecord[]>;
  deleteEntries(id: string): Promise<void>;
}
