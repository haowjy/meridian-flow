CREATE SEQUENCE "public"."context_availability_generation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "context_availability_heads" (
	"authority_key" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
