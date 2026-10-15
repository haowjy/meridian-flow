/**
 * The hidden-node lifecycle's vocabulary, with no database dependency, so ports and
 * adapters can name it without importing the Drizzle implementation (`creates.ts`, `end-use.ts`).
 */
import type { ContextSourceId, DocumentId } from "@meridian/contracts";
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { DocumentCreationMetadata } from "../document-metadata.js";

export type CreateFault =
  /** Opposite kind at the path, or a binary create where a document sits. */
  | { code: "conflict"; occupantKind?: "file" | "folder" }
  /** The path names two or more nodes in the view. */
  | { code: "ambiguous"; ids: readonly string[] };

export type TrackedNode = {
  kind: "tracked";
  filetype: Filetype;
  metadata?: DocumentCreationMetadata;
};

export type BinaryNode = {
  kind: "binary";
  documentId?: DocumentId;
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  metadata?: JsonObject | DocumentCreationMetadata;
};

export type DraftCreateResult =
  /** Something already sits at the path in the draft's view. */
  | { kind: "existing"; documentId: DocumentId; binary: boolean }
  /** The draft now uses this document: a new hidden row, or (`joined`) another draft's. */
  | { kind: "created"; documentId: DocumentId; joined: boolean };

/** What a live create at a path would find, holding nothing (§6.3 step 1). */
export type LiveCreateCandidate =
  /** A visible document or folder holds the path (its kind when one does), or two nodes do. */
  | { kind: "occupant"; occupantKind?: "file" | "folder" }
  /** A hidden text document a live create there would reveal, at its physical source. */
  | { kind: "candidate"; documentId: DocumentId; sourceId: ContextSourceId }
  | { kind: "none" };

/** The hidden document a live create was planned against, at its physical source. */
export type RevealExpectation = {
  documentId: DocumentId;
  sourceId: ContextSourceId;
};

/**
 * What a live create claims under its locks (§6.3 step 4): `any` reveals the hidden
 * document at the path or inserts; `none` inserts and treats a hidden candidate that
 * appeared since discovery as a change; `mint` inserts a caller-minted identity and leaves
 * any hidden document its path in its drafts; `reveal` takes exactly the expected one.
 */
export type LiveClaim =
  | { kind: "any" }
  | { kind: "none" }
  | { kind: "mint" }
  | { kind: "reveal"; reveal: RevealExpectation };
