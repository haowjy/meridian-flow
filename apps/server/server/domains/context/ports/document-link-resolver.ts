import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";

export type { ResolvedDocumentLink };

export interface ResolveDocumentLinkInput {
  projectId: string;
  userId: string;
  workId?: string | null;
  rootThreadId?: string | null;
  chatId?: string | null;
  uri: string;
  previousLocations?: boolean;
}

export interface DocumentLinkResolver {
  resolve(input: ResolveDocumentLinkInput): Promise<ResolvedDocumentLink | null>;
}

export interface DocumentLinkHistory {
  previous(
    input: ResolveDocumentLinkInput,
    address: { sourceId: import("@meridian/contracts").ContextSourceId; path: string },
  ): Promise<string | null>;
}
