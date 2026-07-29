/** Port for resolving every internal-link spelling to one project document. */

export type DocumentLinkTarget =
  | { kind: "wikilink"; name: string }
  | { kind: "scheme"; uri: string }
  | { kind: "relative"; path: string; baseUri: string };

export interface ResolveDocumentLinkInput {
  projectId: string;
  workId?: string | null;
  target: DocumentLinkTarget;
}

export interface ResolvedDocumentLink {
  documentId: string;
  title: string;
  scheme: "manuscript" | "work";
  path: string;
  uri: string;
  workId: string | null;
}

export interface DocumentLinkResolver {
  resolve(input: ResolveDocumentLinkInput): Promise<ResolvedDocumentLink | null>;
}
