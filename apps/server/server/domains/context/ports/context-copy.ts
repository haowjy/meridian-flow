/**
 * What one tree must tell a Copy about itself, and what it must do with what a Copy made.
 *
 * A Copy reads its source subtree once in an explicit view, binds every document's content
 * for the address it will have, and then inserts the whole tree in the caller's transaction.
 * The destination adapter owns naming and insertion because names are its namespace's, and
 * the callback it receives is the only thing it needs from the layer above: the bound
 * content for one file's final address. `context/copy/` owns the orchestration.
 *
 * Binaries are not bound: their bytes were duplicated before the transaction, and the
 * inserted row carries that object.
 */
import type {
  ContextParentOrderPolicy,
  ContextSiblingPosition,
  DocumentFileType,
  Filetype,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { CopyIdentityMap } from "../../collab/index.js";
import type { CopiedFrom } from "../document-metadata.js";
import type { AdapterFault } from "./context-adapter.js";

/** One tracked or binary file in a source tree: what a copy hands on. */
export interface CopySourceFile {
  kind: "file";
  /** Scheme-relative path, including the filename. */
  path: string;
  /** Canonical address of the file in its source. */
  uri: string;
  documentId: string;
  name: string;
  extension: string;
  filetype: Filetype;
  /** Non-null for a binary file; such a file copies its stored object, not content. */
  fileType: DocumentFileType | null;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

/** One folder in a source tree, with the children a reader sees in it. */
export interface CopySourceFolder {
  kind: "folder";
  /** Scheme-relative path, without a trailing slash. */
  path: string;
  /** Canonical address of the folder in its source. */
  uri: string;
  folderId: string;
  name: string;
  /** The folder's own child ordering; a copy keeps it. */
  orderPolicy: ContextParentOrderPolicy;
  /** Children in the folder's visible order (empty folders included). */
  children: CopySourceEntry[];
}

export type CopySourceEntry = CopySourceFolder | CopySourceFile;

/** Content for one copied document, bound for the address its copy lands at. */
export interface CopiedContent {
  /** The copy's first Yjs state; null for a source with no text, whose copy is empty. */
  state: Uint8Array | null;
  copiedFrom: CopiedFrom;
}

/** Every identity one Copy created; roots first, then each root's subtree in source order. */
export interface CopyCreatedEntry {
  kind: "file" | "folder";
  id: string;
  /** Scheme-relative path the copy landed at, including its name. */
  path: string;
  name: string;
  /** The source identity it copies: a document id for a file, a folder id for a folder. */
  copiedFrom: string;
}

/** The copy capability of one scheme adapter. */
export interface ContextCopyAdapter {
  /** This adapter's context source, provisioned; the copy command locks it. */
  sourceId(): Promise<string | null>;
  /**
   * The source subtree at `path`: the folder with every descendant in the folder's visible
   * order (empty folders included), or the one file there. Read once; the copy works from
   * this and never re-lists.
   */
  snapshotSource(path: string): Promise<Result<CopySourceEntry, AdapterFault>>;
  /**
   * Just the identity at `path`, or null. The copy command rechecks every root under its
   * locks: a source deleted between the read and the commit is a gone source, not a copy.
   */
  peekSource(
    path: string,
  ): Promise<Result<{ kind: "file" | "folder"; nodeId: string } | null, AdapterFault>>;
  /**
   * Insert `roots` under the scheme-relative folder `dir`, inside the caller's transaction.
   *
   * Names are allocated against live occupants, hidden occupants (never revealed), and the
   * rest of the batch. Every created node gets its identity before any row is written, so
   * `bind` sees the whole old→new map and cross-root links can point at their copies. A
   * copied folder keeps its source ordering policy, and its children arrive in source order.
   */
  copyInto(input: {
    dir: readonly string[];
    roots: readonly CopySourceEntry[];
    position?: ContextSiblingPosition;
    bind(input: {
      file: CopySourceFile;
      /** The canonical address the copy will have. */
      uri: string;
      /** Every identity this copy creates, old→new, complete before the first bind. */
      map: CopyIdentityMap;
    }): Promise<Result<CopiedContent, AdapterFault>>;
  }): Promise<Result<CopyCreatedEntry[], AdapterFault>>;
}
