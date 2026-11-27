export type ContextImportArea = "manuscript" | "kb" | "unfiled";

export type ContextImportDestination = {
  area: ContextImportArea;
  folderId: string | null;
  uri: string;
  fellBack: boolean;
  children: { id: string; kind: "folder" | "file"; name: string }[];
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
