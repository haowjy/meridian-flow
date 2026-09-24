/**
 * Purpose: JSON-natural DTOs for the recently opened documents list, read one project at a time.
 * Why independent: The empty-editor landing and later in-project switchers share one wire shape.
 */
import type { ProjectContextTreeScheme } from "./http-types.js";

export type RecentDocumentItem = {
  documentId: string;
  projectId: string;
  projectName: string;
  /** Null for No Work and for project-scoped documents. */
  workSlug: string | null;
  scheme: ProjectContextTreeScheme;
  /** Slash-prefixed locator, as elsewhere. */
  path: string;
  /** Display name including extension. */
  name: string;
  filetype: string;
  editable: boolean;
  /** ISO timestamp. */
  openedAt: string;
};

export type ListRecentDocumentsResponse = { documents: RecentDocumentItem[] };

export type RecordRecentDocumentRequest = { documentId: string };

/** `recorded` is false when this open landed inside the recency interval: the row was already there and did not move. */
export type RecordRecentDocumentResponse = { recorded: boolean };
