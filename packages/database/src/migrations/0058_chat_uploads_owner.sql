-- #875: a chat owns its uploads. A chat is a primary thread; its id is stored on the uploads source
-- (`context_sources.chat_thread_id`) and on each intake (`upload_intakes.owner_thread_id`), with no
-- FK, like lineage Scratch's root id: the chat row may not exist at attach time and trashing or
-- purging it must not cascade. No data moves here (the move is a later migration).
-- The widened CHECKs are added NOT VALID and validated by 0059, which also swaps the project-source
-- unique index (it must now exclude chat sources) and builds the intake owner index.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "context_sources" ADD COLUMN "chat_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD COLUMN "owner_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_exactly_one_scope";
--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_valid";
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_exactly_one_scope" CHECK (("context_sources"."scope" = 'project' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NULL) OR ("context_sources"."scope" = 'work' AND "context_sources"."project_id" IS NULL AND "context_sources"."work_id" IS NOT NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NULL) OR ("context_sources"."scope" = 'lineage' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NOT NULL AND "context_sources"."chat_thread_id" IS NULL AND "context_sources"."slug" = 'scratch') OR ("context_sources"."scope" = 'chat' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NOT NULL AND "context_sources"."slug" = 'uploads')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_valid" CHECK ("context_sources"."scope" IN ('project', 'work', 'lineage', 'chat')) NOT VALID;
