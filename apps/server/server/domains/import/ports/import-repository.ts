/** Durable import state and transaction/fence ownership. */
import type { ImportCounts, ImportEntryState, ImportState } from "@meridian/contracts";
import type { ImportArea } from "../domain/export-marker.js";
import type { ImportLinkCandidate } from "../domain/link-index.js";
import type { PlannedNode, PlannedRoot } from "../domain/plan.js";
/**
 * The plan header admission persists: identity, the create command's destination and root
 * descriptors, and its fingerprint. The planned entries are the plan's body; the create
 * command itself is never kept.
 */
export interface ImportRecord {
  id: string;
  projectId: string;
  userId: string;
  /** The destination as the command spelled it; `folderId` is what it resolved to. */
  destinationUri: string;
  roots: PlannedRoot[];
  fingerprint: string;
  sourceId: string;
  folderId: string | null;
  state: ImportState;
  createdAt?: Date;
}
/** What a fence needs to order work: lifecycle state and the destination's source. */
export interface ImportFence {
  state: ImportState;
  sourceId: string;
}
/**
 * What `import_entries.spec` holds: the planned node fields no query or lease logic
 * filters on. Nothing a column owns is ever written here.
 */
export interface ImportEntryPayload
  extends Omit<PlannedNode, "id" | "state" | "kind" | "entryId" | "parentId" | "area"> {
  prependOnRetry: boolean;
}
/** What import_entries columns own: identity, order, planned kind and tree position, lifecycle, lease and sweep state. */
export interface ImportEntryColumns {
  id: string;
  order: number;
  version: string;
  state: ImportEntryState;
  kind: PlannedNode["kind"];
  entryId: number | null;
  parentId: string | null;
  area?: ImportArea;
  prepared: boolean;
  created: boolean;
  attemptId: string | null;
  leaseUntil: Date | null;
  storageUrl: string | null;
  uri: string | null;
  objectSweptAt: Date | null;
}
export type ImportEntry = ImportEntryPayload & ImportEntryColumns;
/** Mutable payload fields. */
export type ImportEntryPayloadPatch = Partial<
  Pick<ImportEntryPayload, "name" | "reason" | "reasonParams" | "prependOnRetry">
>;
/** Mutable column fields. */
export type ImportEntryColumnPatch = Partial<
  Pick<
    ImportEntryColumns,
    | "state"
    | "prepared"
    | "created"
    | "attemptId"
    | "leaseUntil"
    | "storageUrl"
    | "uri"
    | "objectSweptAt"
  >
>;
/** The only fields a caller may change; every other entry field is fixed at planning. */
export type ImportEntryPatch = ImportEntryPayloadPatch & ImportEntryColumnPatch;
export interface ImportRepository {
  transaction<T>(run: () => Promise<T>): Promise<T>;
  /** Persists the whole plan once: header, frozen existing-document snapshot and every node. */
  insert(
    record: ImportRecord,
    existingLinks: readonly ImportLinkCandidate[],
    nodes: PlannedNode[],
  ): Promise<void>;
  read(id: string, projectId: string): Promise<ImportRecord | null>;
  /** Locks the import row, selecting only the fields a fence reads. */
  fence(id: string, projectId: string, exclusive?: boolean): Promise<ImportFence | null>;
  /** The existing-document snapshot frozen at admission. */
  existingLinks(id: string): Promise<ImportLinkCandidate[]>;
  entries(id: string): Promise<ImportEntry[]>;
  /** Which of these file entry ids belong to the import: one lookup, however many. */
  fileEntryIds(importId: string, entryIds: readonly number[]): Promise<Set<number>>;
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
  fileEntry(importId: string, entryId: number): Promise<ImportEntry | null>;
  hasUnfinished(importId: string): Promise<boolean>;
  /** Whether any planned entry still awaits its planning chunk. */
  hasUnprepared(importId: string): Promise<boolean>;
  lockEntry(id: string): Promise<ImportEntry>;
  /** Row locks in ordinal order; skipLocked leaves rows another commit is publishing. */
  lockEntries(ids: readonly string[], options?: { skipLocked?: boolean }): Promise<ImportEntry[]>;
  /** The first unprepared parent's planned, uncreated entries: still pending, and reserved names. */
  nextPlanningGroup(importId: string): Promise<{
    parentId: string | null;
    /** Set for an export's area-root group, whose null parent means that area's root. */
    area?: ImportArea;
    pending: ImportEntry[];
    reserved: ImportEntry[];
  } | null>;
  /** Patch rows the caller already holds locked (or fences out by Finish's exclusive lock). */
  updateEntry(id: string, patch: ImportEntryPatch): Promise<void>;
  updateEntries(patches: readonly { id: string; patch: ImportEntryPatch }[]): Promise<void>;
  setState(id: string, state: ImportState): Promise<void>;
  /** Terminal claimed binaries whose object may still exist, oldest lease first. */
  sweepCandidates(
    now: Date,
    scope: { importId?: string; limit: number; graceMs: number },
  ): Promise<{ id: string; importId: string; entryId: number }[]>;
  markSwept(ids: readonly string[], at: Date | null): Promise<void>;
}
