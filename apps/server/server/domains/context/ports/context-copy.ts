import type { BranchId } from "@meridian/contracts";
/**
 * What one tree must tell a Copy about itself, and what it must do with what a Copy made.
 *
 * A Copy reads its source subtree once in an explicit view. The destination adapter then plans
 * the tree it will insert (names and identities, which are its namespace's to decide), the
 * layer above binds every document's content for the address its copy will have, and the
 * adapter inserts the whole tree in the caller's transaction. Planning and binding hold no
 * lock; a copy keeps its source's names, so one beside a sibling of that name is a twin and the
 * entries say the path that landed. `context/copy/` owns the orchestration.
 *
 * Binaries are not bound: their bytes were duplicated before the transaction, and the
 * inserted row carries that object.
 */
import type {
  ContextSiblingPosition,
  DocumentFileType,
  Filetype,
} from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";
import type { BoundWrite, CopyIdentityMap } from "../../collab/index.js";
import type { CopiedFrom } from "../document-metadata.js";
import type { TreeView } from "../tree/tree-view.js";
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
  /** A browser-drawable preview sits beside the stored object. */
  hasPreview: boolean;
  /** Set by the command on a selected root only: the client's id for the root's copy. */
  copyId?: string;
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
  /** Children in the folder's visible order (empty folders included). */
  children: CopySourceEntry[];
  /** Set by the command on a selected root only: the client's id for the root's copy. */
  copyId?: string;
}

export type CopySourceEntry = CopySourceFolder | CopySourceFile;

/** Content for one copied document, bound for the address its copy lands at. */
export interface CopiedContent {
  content?: BoundWrite | null;
  state: Uint8Array | null;
  copiedFrom?: CopiedFrom;
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

/** One folder of the tree a copy will insert: the source it copies and the identity it gets. */
export interface PlannedCopyFolder {
  kind: "folder";
  source: CopySourceFolder;
  id: string;
  /** The allocated name. */
  name: string;
  /** Scheme-relative path of the copy, including its name. */
  path: string;
  /** Canonical address of the copy. */
  uri: string;
  children: PlannedCopyNode[];
}

/** One file of the tree a copy will insert. */
export interface PlannedCopyFile {
  kind: "file";
  source: CopySourceFile;
  id: string;
  /** The allocated name and extension, split as the row stores them. */
  name: string;
  extension: string;
  path: string;
  uri: string;
}

export type PlannedCopyNode = PlannedCopyFolder | PlannedCopyFile;

/**
 * Names and identities for one copy, made without a lock. A name is only as good as the
 * occupants it was allocated around, so `copyInto` confirms the roots' names under its lock.
 */
export interface CopyPlan {
  /** The destination folder the roots were planned into. */
  dir: readonly string[];
  /** One per selected root, in the order selected. */
  roots: readonly PlannedCopyNode[];
  /** Every identity this copy creates, old→new: complete before the first bind. */
  map: CopyIdentityMap;
  /** The tracked documents whose content the caller binds. */
  documents: readonly PlannedCopyFile[];
}

/** What an insert did: the identities it created, or that its plan no longer holds. */
export type CopyOutcome =
  | {
      kind: "copied";
      entries: CopyCreatedEntry[];
      /** The folders the insert made to reach its destination, outermost first. */
      folders: string[];
    }
  | { kind: "replan" };

/** The copy capability of one scheme adapter. */
export interface ContextCopyAdapter {
  /** This adapter's context source, provisioned; the copy command locks it. */
  sourceId(): Promise<string | null>;
  /**
   * The source subtree of node `id`: the folder with every descendant in the folder's visible
   * order (empty folders included), or the one file. The node is found by its id wherever it
   * stands now, in Trash too (`not_found` when it is purged or in another source); `path` only
   * spells its address. A draft `view` reads the Work's tree instead, where the node must be
   * placed. Read once; the copy works from this and never re-lists.
   */
  snapshotSource(source: {
    id: string;
    path: string;
    view: TreeView;
  }): Promise<Result<CopySourceEntry, AdapterFault>>;
  /**
   * Plan `roots` under the scheme-relative folder `dir`: mint every identity, writing nothing
   * and holding no lock. A selected root that carries the device's `copyId` takes it; every
   * descendant is minted here. Each keeps its source's name. A copied folder
   * keeps its source ordering policy, and its children arrive in source order.
   */
  planCopy(input: {
    dir: readonly string[];
    roots: readonly CopySourceEntry[];
  }): Promise<Result<CopyPlan, AdapterFault>>;
  /**
   * Insert a plan, inside the caller's transaction and under its locks. `contents` has one
   * entry per tracked document in the plan, by source document id. When the plan was made for
   * another folder, nothing is inserted and the answer is `replan`.
   */
  copyInto(input: {
    dir: readonly string[];
    /** The folder the writer named by id (it may be in Trash: a copy into it stands it again), and the folders made under it. */
    parent?: { folderId: string; createFolders: readonly string[] };
    plan: CopyPlan;
    contents: ReadonlyMap<string, CopiedContent>;
    branchId: BranchId | null;
    position?: ContextSiblingPosition;
  }): Promise<Result<CopyOutcome, AdapterFault>>;
}
