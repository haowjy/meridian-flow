import type { DraftId } from "@meridian/contracts";
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

export interface CopySourceFile {
  kind: "file";
  path: string;
  uri: string;
  documentId: string;
  name: string;
  extension: string;
  filetype: Filetype;
  fileType: DocumentFileType | null;
  storageUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  hasPreview: boolean;
  copyId?: string;
}

export interface CopySourceFolder {
  kind: "folder";
  path: string;
  uri: string;
  folderId: string;
  name: string;
  children: CopySourceEntry[];
  copyId?: string;
}

export type CopySourceEntry = CopySourceFolder | CopySourceFile;

export interface CopiedContent {
  content?: BoundWrite | null;
  state: Uint8Array | null;
  copiedFrom?: CopiedFrom;
}

export interface CopyCreatedEntry {
  kind: "file" | "folder";
  id: string;
  path: string;
  name: string;
  copiedFrom: string;
}

export interface PlannedCopyFolder {
  kind: "folder";
  source: CopySourceFolder;
  id: string;
  name: string;
  path: string;
  uri: string;
  children: PlannedCopyNode[];
}

export interface PlannedCopyFile {
  kind: "file";
  source: CopySourceFile;
  id: string;
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
  dir: readonly string[];
  roots: readonly PlannedCopyNode[];
  map: CopyIdentityMap;
  documents: readonly PlannedCopyFile[];
}

export type CopyOutcome =
  | {
      kind: "copied";
      entries: CopyCreatedEntry[];
      folders: string[];
    }
  | { kind: "replan" };

export interface ContextCopyAdapter {
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
    parent?: { folderId: string; createFolders: readonly string[] };
    plan: CopyPlan;
    contents: ReadonlyMap<string, CopiedContent>;
    draftId: DraftId | null;
    position?: ContextSiblingPosition;
  }): Promise<Result<CopyOutcome, AdapterFault>>;
}
