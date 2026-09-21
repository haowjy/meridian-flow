/**
 * Purpose: JSON-natural DTOs for the account-global recently opened documents list.
 * Why independent: The empty-editor landing, Home, and later switchers share one wire shape.
 */
import type { ProjectContextTreeScheme } from "./http-types.js";

export type RecentDocumentItem = {
  documentId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
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
