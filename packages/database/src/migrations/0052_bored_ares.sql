ALTER TABLE "document_yjs_checkpoints" ADD COLUMN "authority_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD COLUMN "authority_generation" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD COLUMN "attribution_manifest" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD COLUMN "authority_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD COLUMN "authority_generation" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD COLUMN "next_admission_sequence" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "authority_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "authority_generation" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "admission_sequence" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "batch_ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_updates_authority_admission" ON "document_yjs_updates" USING btree ("authority_id","authority_generation","admission_sequence","batch_ordinal");