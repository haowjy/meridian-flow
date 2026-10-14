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
import type { Filetype } from "@meridian/contracts/protocol";
export type ImportRoot = ImportSelection["roots"][number] & { id: string | null; created: boolean };
export interface ImportRecord {
  id: string;
  projectId: string | null;
  userId: string;
  destinationUri: string;
  folderId: string | null;
  roots: ImportRoot[];
  placement: Record<string, unknown> | null;
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
export interface ImportEntrySpec {
  rootId: number;
  path: string;
  size: number;
  modifiedAt: number;
  reasonParams?: { readReason: ImportUnreadableReason };
  fileKind?: "note" | "code" | "docx" | "binary";
  filetype?: Filetype;
  mimeType?: string;
  name?: string;
  extension?: string;
  aliases?: string[];
}
export interface ImportEntry {
  id: string;
  importId: string;
  ordinal: number;
  kind: "folder" | "file" | "unreadable";
  entryId: number | null;
  spec: ImportEntrySpec;
  state: ImportEntryState;
  reason: ImportEntryReason | null;
  storageUrl: string | null;
  objectKey: string | null;
  convertedKey: string | null;
  receivedSize: number | null;
  sha256: string | null;
}
export type ImportPatch = Partial<
  Omit<ImportRecord, "id" | "projectId" | "userId" | "fingerprint" | "createdAt">
>;
export type ImportEntryPatch = Partial<
  Pick<
    ImportEntry,
    | "spec"
    | "state"
    | "reason"
    | "storageUrl"
    | "objectKey"
    | "convertedKey"
    | "receivedSize"
    | "sha256"
  >
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
  maintenanceCandidates(limit: number): Promise<ImportRecord[]>;
  deleteEntries(id: string): Promise<void>;
}
