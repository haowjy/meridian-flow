ALTER TABLE "push_lineage" ADD COLUMN "receipt_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "push_lineage_receipt" ON "push_lineage" USING btree ("receipt_id");
