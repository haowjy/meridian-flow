/** Live-tree facts used to prepare an import without taking mutation locks. */
export type ContextImportArea = "manuscript" | "kb" | "unfiled";

export type ContextImportDestination = {
  area: ContextImportArea;
  folderId: string | null;
  uri: string;
  fellBack: boolean;
  /** `name` is the filename as the tree shows it. */
  children: { kind: "folder" | "file"; name: string }[];
};

export type ContextImportLinkCandidate = {
  id: string;
  uri: string;
  path: string;
  aliases: string[];
  filetype: string;
};

export interface ContextImportRead {
  destinations(input: {
    destinationUri: string;
    folderId: string | null;
    areas: readonly ContextImportArea[];
  }): Promise<ContextImportDestination[]>;
  linkCandidates(): Promise<ContextImportLinkCandidate[]>;
}
