/** Identity-based context writes; methods join the repository's ambient transaction. */
import type { StoredDocumentProperties } from "@meridian/contracts";
import type { BoundWrite } from "../../collab/index.js";
import type { ImportLinkCandidate } from "../domain/link-index.js";
import type { ImportEntry, ImportRecord } from "./import-repository.js";
export interface ImportParent {
  sourceId: string;
  folderId: string | null;
  uri: string;
  children: { kind: "folder" | "file"; name: string; extension: string }[];
}
export class ParentMovedError extends Error {}
/** One entry's content to bind; occurrences are numbered in `text`'s own parse. */
export interface ImportWrite {
  text: string;
  targets?: ReadonlyMap<number, string>;
  /** Written hrefs of converted occurrences; `text` spells them apart as placeholders. */
  hrefs?: ReadonlyMap<number, string>;
  /** Planned ids bound by an ahead ref while not yet live, never by address. */
  pending?: ReadonlySet<string>;
}
export interface ImportTreeWriter {
  existingLinks(): Promise<ImportLinkCandidate[]>;
  setProperties(
    id: string,
    properties: StoredDocumentProperties | null,
    aliases: string[],
  ): Promise<void>;
  destination(uri: string): Promise<{ sourceId: string; folderId: string | null }>;
  /** Resolve, lock the current source, reread. Throw ParentMovedError to retry a fresh transaction. */
  parent(record: ImportRecord, folderId: string | null): Promise<ImportParent | null>;
  lockDocument(id: string): Promise<boolean>;
  create(parent: ImportParent, nodes: ImportEntry[]): Promise<void>;
  bind(entry: ImportEntry, write: ImportWrite): Promise<BoundWrite | null>;
  aheadTargets(
    bound: BoundWrite,
    holderUri: string,
    entries: readonly ImportEntry[],
    targets?: ReadonlyMap<number, string>,
  ): { targetId: string; ref: string }[];
  /** Settle a ref awaiting this planned file to it, by ref id. */
  settleAhead(ref: string, documentId: string): Promise<void>;
  /** These planned files will never land: links awaiting them become ordinary ahead links. */
  releaseAhead(documentIds: readonly string[]): Promise<void>;
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
  /** Batched current addresses; ids without a live address are absent. */
  currentUris(ids: {
    files: readonly string[];
    folders: readonly string[];
  }): Promise<Map<string, string>>;
}
