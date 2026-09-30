UPDATE "works" SET "archived_at" = COALESCE("archived_at", "updated_at") WHERE "status" = 'archived' AND "archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_no_work_active";--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_status_valid";--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "status"; /* -- migration-lint: skip DROP_COLUMN (no deployed data; the enum is replaced by free text in the same change) */--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_no_work_not_archived" CHECK (NOT "works"."is_no_work" OR "works"."archived_at" IS NULL);--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_status_length" CHECK ("works"."status" IS NULL OR char_length("works"."status") <= 32);
