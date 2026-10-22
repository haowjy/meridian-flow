-- Validation runs separately from ADD CHECK: its scan must not retain an ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_deleted_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_deletion_reason_valid";
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_deletion_cause_valid";
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_removal_presence";
--> statement-breakpoint
ALTER TABLE "document_drafts" VALIDATE CONSTRAINT "document_drafts_closed_cause_valid";
--> statement-breakpoint
ALTER TABLE "document_drafts" VALIDATE CONSTRAINT "document_drafts_closed_cause_presence";
