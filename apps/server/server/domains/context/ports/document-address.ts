/** Browser document locations resolve separately from model-visible wikilinks. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { DocumentAddressResult, ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export type DocumentAddressInput = {
  projectId: ProjectId;
  userId: string;
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  path: string;
};

export interface DocumentAddressStore {
  /** A current folder or unavailable source suppresses history just like a current file. */
  candidate(
    input: DocumentAddressInput,
  ): Promise<{ kind: "current" | "alias"; documentId: DocumentId } | null>;
}

export interface DocumentAddressResolver {
  resolve(input: DocumentAddressInput): Promise<DocumentAddressResult>;
}
