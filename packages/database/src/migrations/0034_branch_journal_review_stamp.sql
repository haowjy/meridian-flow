ALTER TABLE "branch_write_journal" ADD COLUMN "reviewed_by" uuid;
ALTER TABLE "branch_write_journal" ADD COLUMN "reviewed_at" timestamp with time zone;
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
