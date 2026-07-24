ALTER TABLE "pending_notice_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "pending_notice_deliveries" CASCADE;--> statement-breakpoint
ALTER TABLE "pending_notices" DROP CONSTRAINT "pending_notices_scope_valid";--> statement-breakpoint
ALTER TABLE "pending_notices" ADD COLUMN "thread_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_notices" ADD CONSTRAINT "pending_notices_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_notices_thread" ON "pending_notices" USING btree ("thread_id","created_at","id");--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "scope_kind";--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "scope_id";