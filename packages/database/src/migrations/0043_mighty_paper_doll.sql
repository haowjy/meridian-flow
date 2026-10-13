SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD COLUMN "retired_through_seq" bigint DEFAULT 0 NOT NULL;