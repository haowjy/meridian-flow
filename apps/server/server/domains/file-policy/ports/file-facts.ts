import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { FileFacts, FileTarget } from "../domain/types.js";

export interface FileFactsRequest {
  target: FileTarget;
  draftOwner?: DraftId;
}

export interface FileFactsPort {
  load(request: FileFactsRequest): Promise<FileFacts | null>;
  loadList(
    documentIds: readonly DocumentId[],
    draftOwner?: DraftId,
    draftViews?: ReadonlyMap<DocumentId, TreeView>,
  ): Promise<Map<DocumentId, FileFacts>>;
}
