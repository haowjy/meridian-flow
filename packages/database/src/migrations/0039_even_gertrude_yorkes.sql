ALTER TABLE "document_branches" ADD COLUMN "has_effect" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "live_cut" "bytea";