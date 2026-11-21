/** Port: load the facts the file policy decides on (file-access §2, §5). */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { FileFacts, FileTarget } from "../domain/types.js";

export interface FileFactsRequest {
  target: FileTarget;
  /**
   * The owner whose draft this access goes through, asked only for a draft destination.
   * A `draft` target names its own; facts then include `draftOwner`.
   */
  draftOwner?: DraftId;
}

export interface FileFactsPort {
  /** Unlocked read; null when the target doesn't exist. */
  load(request: FileFactsRequest): Promise<FileFacts | null>;
  /**
   * The list path (file-access §6): many documents' facts in one query, each
   * through `draftOwner`'s draft when given. Folders are left out of
   * `ancestors`: a listed row is already visible, and v1 grants
   * sit on the project. Missing documents are absent from the map.
   */
  loadList(
    documentIds: readonly DocumentId[],
    draftOwner?: DraftId,
    draftViews?: ReadonlyMap<DocumentId, TreeView>,
  ): Promise<Map<DocumentId, FileFacts>>;
}
