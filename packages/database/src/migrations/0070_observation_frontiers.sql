-- Observation frontiers (M1): a new table, so creating it rewrites nothing. The foreign key is added
-- NOT VALID under the lock timeout, which bounds the SHARE ROW EXCLUSIVE lock it takes on
-- turn_blocks, then validated: the new table is empty, so validation scans nothing.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "observation_frontiers" (
	"source_block_id" uuid NOT NULL,
	"room_key" text NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"unshown" jsonb NOT NULL,
	"recorded_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "observation_frontiers_recorded_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	CONSTRAINT "observation_frontiers_pk" PRIMARY KEY("source_block_id","room_key")
);
--> statement-breakpoint
ALTER TABLE "observation_frontiers" ADD CONSTRAINT "observation_frontiers_source_block_id_turn_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "observation_frontiers" VALIDATE CONSTRAINT "observation_frontiers_source_block_id_turn_blocks_id_fk";
