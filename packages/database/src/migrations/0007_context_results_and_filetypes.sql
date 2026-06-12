ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_file_type_valid";
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_type_valid" CHECK (
  "file_type" IN (
    'markdown', 'python', 'typescript', 'javascript', 'json', 'shell', 'yaml', 'text', 'csv', 'notebook',
    'pdf', 'png', 'jpg', 'svg', 'docx', 'image', 'binary'
  )
);

CREATE TABLE IF NOT EXISTS "workbench_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workbench_id" uuid NOT NULL,
  "source_path" text NOT NULL,
  "results_uri" text NOT NULL,
  "storage_url" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "root_thread_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "tool_call_id" text,
  "agent_slug" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbench_results_size_bytes_nonneg" CHECK ("size_bytes" >= 0)
);

ALTER TABLE "workbench_results" ADD CONSTRAINT "workbench_results_workbench_id_projects_id_fk" FOREIGN KEY ("workbench_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "workbench_results" ADD CONSTRAINT "workbench_results_root_thread_id_threads_id_fk" FOREIGN KEY ("root_thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "workbench_results" ADD CONSTRAINT "workbench_results_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "workbench_results" ADD CONSTRAINT "workbench_results_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX IF NOT EXISTS "workbench_results_workbench_created_idx" ON "workbench_results" USING btree ("workbench_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "workbench_results_root_thread_idx" ON "workbench_results" USING btree ("root_thread_id", "created_at" DESC);
