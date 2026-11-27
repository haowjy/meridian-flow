import type { ProjectContextTreeScheme } from "./http-types.js";

export type RecentDocumentItem = {
  documentId: string;
  projectId: string;
  projectName: string;
  workHandle: string | null;
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  filetype: string;
  editable: boolean;
  openedAt: string;
};

export type ListRecentDocumentsResponse = { documents: RecentDocumentItem[] };

export type RecordRecentDocumentResponse = { recorded: boolean };
