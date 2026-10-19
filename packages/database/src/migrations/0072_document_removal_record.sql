SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "closed_cause" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deletion_reason" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deletion_cause" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_closed_cause_valid" CHECK ("document_drafts"."closed_cause" IN ('discarded', 'document_removed')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deletion_reason_valid" CHECK ("documents"."deletion_reason" IN ('deleted', 'discarded')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deletion_cause_valid" CHECK ("documents"."deletion_cause" IN ('reply_rolled_back', 'create_failed', 'repair')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_closed_cause_presence" CHECK (("document_drafts"."status" = 'closed') = ("document_drafts"."closed_cause" IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_removal_presence" CHECK (("documents"."deleted_at" IS NOT NULL) = ("documents"."deletion_reason" IS NOT NULL)) NOT VALID;
