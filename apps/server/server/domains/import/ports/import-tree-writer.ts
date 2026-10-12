/** Identity-based context writes; methods join the repository's ambient transaction. */
import type { BoundWrite } from "../../collab/index.js";
import type { ImportEntry, ImportRecord } from "./import-repository.js";
export interface ImportParent {
  sourceId: string;
  folderId: string | null;
  uri: string;
  children: { kind: "folder" | "file"; name: string; extension: string }[];
}
export class ParentMovedError extends Error {}
export interface ImportTreeWriter {
  preview(uri: string): Promise<ImportParent["children"]>;
  destination(uri: string): Promise<{ sourceId: string; folderId: string | null }>;
  /** Resolve, lock the current source, reread. Throw ParentMovedError to retry a fresh transaction. */
  parent(record: ImportRecord, folderId: string | null): Promise<ImportParent | null>;
  lockDocument(id: string): Promise<boolean>;
  create(parent: ImportParent, nodes: ImportEntry[]): Promise<void>;
  bind(entry: ImportEntry, text: string): Promise<BoundWrite | null>;
  aheadTargets(
    bound: BoundWrite,
    holderUri: string,
    entries: readonly ImportEntry[],
  ): { targetId: string; ref: string }[];
  settleAhead(ref: string, documentId: string): Promise<{ documentId: string } | null>;
  fill(
    entry: ImportEntry,
    bound: BoundWrite,
    prepend: boolean,
  ): Promise<"filled" | "edited" | "deleted">;
  land(
    parent: ImportParent,
    entry: ImportEntry,
    bound: BoundWrite | null,
    bytes: Uint8Array,
  ): Promise<void>;
  clearPending(ids: readonly string[]): Promise<void>;
  currentUri(id: string, kind: "folder" | "file"): Promise<string | null>;
}
