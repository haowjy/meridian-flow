/** Durable import state and transaction/fence ownership. */
import type {
  ImportCounts,
  ImportEntryState,
  ImportManifest,
  ImportState,
} from "@meridian/contracts";
import type { ImportLinkCandidate } from "../domain/link-index.js";
import type { PlannedNode } from "../domain/plan.js";
export interface ImportRecord {
  id: string;
  projectId: string;
  userId: string;
  manifest: ImportManifest & { existingLinks?: ImportLinkCandidate[] };
  fingerprint: string;
  sourceId: string;
  folderId: string | null;
  state: ImportState;
  createdAt?: Date;
  dismissedAt?: Date | null;
}
export interface ImportEntry extends Omit<PlannedNode, "state"> {
  state: ImportEntryState;
  created: boolean;
  prepared: boolean;
  prependOnRetry: boolean;
  pendingRefs: { holderId: string; ref: string }[];
  order: number;
  version: string;
  attemptId: string | null;
  leaseUntil: Date | null;
  storageUrl: string | null;
  uri: string | null;
}
export interface ImportRepository {
  transaction<T>(run: () => Promise<T>): Promise<T>;
  insert(record: ImportRecord, nodes: PlannedNode[]): Promise<void>;
  read(id: string, projectId: string): Promise<ImportRecord | null>;
  fence(id: string, projectId: string, exclusive?: boolean): Promise<ImportRecord | null>;
  entries(id: string): Promise<ImportEntry[]>;
  snapshot(
    id: string,
    projectId: string,
    since?: string,
  ): Promise<{
    record: ImportRecord;
    entries: ImportEntry[];
    counts: ImportCounts;
    lastActivityAt: string;
    version: string;
  } | null>;
  listOpen(
    projectId: string,
  ): Promise<
    { record: ImportRecord; counts: ImportCounts; lastActivityAt: string; version: string }[]
  >;
  touch(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  fileEntry(importId: string, entryId: number): Promise<ImportEntry | null>;
  hasUnfinished(importId: string): Promise<boolean>;
  lockEntry(id: string): Promise<ImportEntry>;
  updateEntry(id: string, patch: Partial<ImportEntry>): Promise<void>;
  setState(id: string, state: ImportState): Promise<void>;
  sweepCandidates(
    now: Date,
  ): Promise<{ id: string; importId: string; storageUrl: string | null; entryId: number | null }[]>;
}
