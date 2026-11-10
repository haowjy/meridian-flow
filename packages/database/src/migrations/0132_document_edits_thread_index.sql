-- migration: no-transaction
-- Online-safe: one index, no column or row changes. Serves the document "related" read
-- (which chats made agent edits to a document) without scanning a chapter's whole edit history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edits_document_thread_idx"
  ON "document_edits" ("document_id", "thread_id")
  WHERE "thread_id" IS NOT NULL;
--> statement-breakpoint
-- Serves the recent-documents read, which finds a chat's agent edits by thread alone.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edits_thread_idx"
  ON "document_edits" ("thread_id")
  WHERE "thread_id" IS NOT NULL;
