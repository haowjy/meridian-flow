-- migration: no-transaction
-- Two new tables whose indexes and constraints scan no rows, then the old projection tables go:
-- every reader moved in the same change, and the block rows re-derive from Yjs through the sweep.
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_block_rooms" (
	"room_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_block_rooms_room_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"block_order" text[] NOT NULL,
	"word_count" integer NOT NULL,
	"document_bytes" bigint NOT NULL,
	"document_hash" "bytea" NOT NULL,
	"cut_generation" bigint NOT NULL,
	"cut_admission_seq" bigint NOT NULL,
	"cut_location_version" bigint NOT NULL,
	"extractor_version" integer NOT NULL,
	"derived_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_blocks" (
	"room_id" bigint NOT NULL,
	"block_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"text" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"word_count" integer NOT NULL,
	CONSTRAINT "document_blocks_room_id_block_id_pk" PRIMARY KEY("room_id","block_id")
);
--> statement-breakpoint
-- Drizzle cannot model fillfactor. The room row is updated on every save and changes no indexed
-- column, so spare page room keeps those updates HOT.
ALTER TABLE "document_block_rooms" SET (fillfactor = 90);
--> statement-breakpoint
ALTER TABLE "document_block_rooms" ADD CONSTRAINT "document_block_rooms_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_blocks" ADD CONSTRAINT "document_blocks_room_id_document_block_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."document_block_rooms"("room_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "document_block_rooms" VALIDATE CONSTRAINT "document_block_rooms_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "document_blocks" VALIDATE CONSTRAINT "document_blocks_room_id_document_block_rooms_room_id_fk";--> statement-breakpoint
SET lock_timeout = '0';
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "document_block_rooms_document" ON "document_block_rooms" USING btree ("document_id");
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "document_markdown_projections";--> statement-breakpoint
DROP TABLE IF EXISTS "document_derivations";
