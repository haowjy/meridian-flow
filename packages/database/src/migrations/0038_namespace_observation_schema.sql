SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE SEQUENCE "public"."context_namespace_observation_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "context_availability_heads" ADD COLUMN "namespace_generation" bigint DEFAULT 0 NOT NULL;
