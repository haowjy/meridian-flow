CREATE TABLE "thread_image_inclusions" (
	"thread_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"included" boolean NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_image_inclusions_thread_id_block_id_pk" PRIMARY KEY("thread_id","block_id")
);
--> statement-breakpoint
ALTER TABLE "turn_blocks" DROP CONSTRAINT "turn_blocks_image_inclusion_only";--> statement-breakpoint
ALTER TABLE "thread_image_inclusions" ADD CONSTRAINT "thread_image_inclusions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_image_inclusions" ADD CONSTRAINT "thread_image_inclusions_block_id_turn_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" DROP COLUMN "image_included";