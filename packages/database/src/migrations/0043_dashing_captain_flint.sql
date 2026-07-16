CREATE TABLE "change_trail_delivery_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"trail_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"event_kind" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_trail_delivery_outbox_event_kind_valid" CHECK ("change_trail_delivery_outbox"."event_kind" IN ('updated', 'settled'))
);
--> statement-breakpoint
CREATE TABLE "change_trail_document_details" (
	"trail_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_title" text NOT NULL,
	"changes" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_trail_document_details_trail_id_document_id_pk" PRIMARY KEY("trail_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "change_trail_shells" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"owner_kind" text NOT NULL,
	"state" text DEFAULT 'building' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_count" integer NOT NULL,
	"swept_change_count" integer NOT NULL,
	"document_count" integer NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_trail_shells_owner_kind_valid" CHECK ("change_trail_shells"."owner_kind" IN ('turn', 'shared')),
	CONSTRAINT "change_trail_shells_owner_shape" CHECK (("change_trail_shells"."owner_kind" = 'turn' AND "change_trail_shells"."turn_id" IS NOT NULL) OR ("change_trail_shells"."owner_kind" = 'shared' AND "change_trail_shells"."turn_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_document_details" ADD CONSTRAINT "change_trail_document_details_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_document_details" ADD CONSTRAINT "change_trail_document_details_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_trail_delivery_outbox_version" ON "change_trail_delivery_outbox" USING btree ("trail_id","version","event_kind");--> statement-breakpoint
CREATE INDEX "change_trail_delivery_outbox_pending" ON "change_trail_delivery_outbox" USING btree ("created_at") WHERE "change_trail_delivery_outbox"."delivered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "change_trail_shells_turn_owner" ON "change_trail_shells" USING btree ("thread_id","turn_id") WHERE "change_trail_shells"."owner_kind" = 'turn';--> statement-breakpoint
CREATE UNIQUE INDEX "change_trail_shells_shared_owner" ON "change_trail_shells" USING btree ("thread_id") WHERE "change_trail_shells"."owner_kind" = 'shared';