DROP INDEX IF EXISTS "agent_edit_mutations_document_thread_write_id";
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_write_id"
  ON "agent_edit_mutations" ("document_id", "thread_id", "write_id", "scope_id")
  WHERE "status" = 'active';
