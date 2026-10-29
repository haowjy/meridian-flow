SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "opened_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "draft_answers" jsonb;
--> statement-breakpoint
-- A question ask now holds a list of questions and one answer per question. Rewrite the rows
-- of the single-question shape. An ask open now counts its 55-minute limit from its creation.
UPDATE "asks" SET "opened_at" = "created_at" WHERE "status" = 'open';
--> statement-breakpoint
UPDATE "asks" SET "payload" = jsonb_build_object('questions', jsonb_build_array("payload"))
  WHERE "kind" = 'question' AND "payload" ? 'question';
--> statement-breakpoint
UPDATE "asks" SET "resolution" = jsonb_build_object('kind', 'answers', 'answers', jsonb_build_array("resolution"))
  WHERE "kind" = 'question' AND "resolution"->>'kind' IN ('option', 'text', 'skipped');
--> statement-breakpoint
UPDATE "asks" SET "resolution" = jsonb_build_object('kind', 'timeout', 'answers', jsonb_build_array(jsonb_build_object('kind', 'timeout', 'label', "resolution"->'label')))
  WHERE "kind" = 'question' AND "resolution"->>'kind' = 'timeout' AND "resolution" ? 'label';
