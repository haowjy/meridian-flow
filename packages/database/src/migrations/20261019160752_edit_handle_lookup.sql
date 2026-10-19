-- migration: no-transaction
-- Receipt retry and source lookup must not scan the document's accumulated edit history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edits_agent_handle_idx" ON "document_edits" USING btree ("document_id","thread_id","w_id") WHERE "document_edits"."actor" = 'agent' AND "document_edits"."w_id" IS NOT NULL;
