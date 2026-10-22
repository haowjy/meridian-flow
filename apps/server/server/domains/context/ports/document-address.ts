/** Browser document locations resolve separately from document links in prose. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentAddressResult, ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import type { TreeView } from "../tree/tree-view.js";

export type DocumentAddressInput = {
  projectId: ProjectId;
  userId: string;
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  rootThreadId?: string | null;
  chatThreadId?: string | null;
  path: string;
  view?: TreeView;
};

export interface DocumentAddressStore {
  /** A current folder or unavailable source suppresses history just like a current file. */
  candidate(
    input: DocumentAddressInput,
  ): Promise<{ kind: "current" | "alias"; documentId: DocumentId } | null>;
}

export type DocumentIdentityAddressInput = Pick<
  DocumentAddressInput,
  "projectId" | "userId" | "view"
> & { documentId: DocumentId };

export interface DocumentAddressResolver {
  /**
   * A validated review item (one document's draft) selects identity, never the occupant of its
   * locator. Its draft admits it like a write (`admitDrafts`): an open no-effect draft of a
   * document deleted live still opens.
   */
  resolveById(input: DocumentIdentityAddressInput): Promise<DocumentAddressResult>;
  resolve(input: DocumentAddressInput): Promise<DocumentAddressResult>;
}
