import type { ContextUriScheme } from "../context-uri.js";

export interface ResolvedDocumentLink {
  rootThreadId?: string | null;
  chatThreadId?: string | null;
  documentId: string;
  title: string;
  scheme: ContextUriScheme;
  path: string;
  uri: string;
  workId: string | null;
  file?: { fileType: string; mimeType: string | null; sizeBytes: number | null };
}
