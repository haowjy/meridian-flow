SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_tree_change_valid_v2" CHECK ("document_edits"."tree_change" IS NULL OR (
        "document_edits"."tree_change"->>'op' IN ('create','move','delete','restore','settle')
        AND "document_edits"."tree_change"->'destination'->>'kind' IN ('live','draft')
        AND jsonb_typeof("document_edits"."tree_change"->'seq') = 'number'
        AND jsonb_typeof("document_edits"."tree_change"->'targets') = 'array'
        AND ("document_edits"."tree_change"->>'op' <> 'settle' OR "document_edits"."tree_change" ? 'settles')
      )) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_tree_change_valid_v2";
--> statement-breakpoint
SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_edits" DROP CONSTRAINT "document_edits_tree_change_valid";
--> statement-breakpoint
ALTER TABLE "document_edits" RENAME CONSTRAINT "document_edits_tree_change_valid_v2" TO "document_edits_tree_change_valid";
