DROP TRIGGER threads_frozen_prompt ON threads;
--> statement-breakpoint
DROP FUNCTION enforce_thread_prompt_freeze();
--> statement-breakpoint
CREATE TABLE "prompt_bakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_thread_id" uuid NOT NULL,
	"composed_system_prompt" text NOT NULL,
	"baked_skill_slugs" jsonb NOT NULL,
	"baked_tools" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "initial_prompt_bake_id" uuid;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "prompt_bake_id" uuid;--> statement-breakpoint
ALTER TABLE "prompt_bakes" ADD CONSTRAINT "prompt_bakes_owner_thread_id_threads_id_fk" FOREIGN KEY ("owner_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_bakes_owner_created" ON "prompt_bakes" USING btree ("owner_thread_id","created_at");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_initial_prompt_bake_id_prompt_bakes_id_fk" FOREIGN KEY ("initial_prompt_bake_id") REFERENCES "public"."prompt_bakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_prompt_bake_id_prompt_bakes_id_fk" FOREIGN KEY ("prompt_bake_id") REFERENCES "public"."prompt_bakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "composed_system_prompt";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "baked_skill_slugs";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "baked_tools";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "system_prompt_hash";
--> statement-breakpoint
ALTER TABLE "threads" ALTER CONSTRAINT "threads_initial_prompt_bake_id_prompt_bakes_id_fk" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "turns" ALTER CONSTRAINT "turns_prompt_bake_id_prompt_bakes_id_fk" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION enforce_prompt_bake_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_value jsonb;
  new_value jsonb;
BEGIN
  old_value := to_jsonb(OLD) -> TG_ARGV[0];
  new_value := to_jsonb(NEW) -> TG_ARGV[0];
  IF old_value IS DISTINCT FROM 'null'::jsonb AND new_value IS DISTINCT FROM old_value THEN
    RAISE EXCEPTION 'Prompt bake pointer is write-once'
      USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[1];
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER threads_initial_prompt_bake_write_once
BEFORE UPDATE OF initial_prompt_bake_id ON threads
FOR EACH ROW EXECUTE FUNCTION enforce_prompt_bake_write_once('initial_prompt_bake_id', 'threads_initial_prompt_bake_write_once');
--> statement-breakpoint
CREATE TRIGGER turns_prompt_bake_write_once
BEFORE UPDATE OF prompt_bake_id ON turns
FOR EACH ROW EXECUTE FUNCTION enforce_prompt_bake_write_once('prompt_bake_id', 'turns_prompt_bake_write_once');
--> statement-breakpoint
CREATE FUNCTION enforce_prompt_bake_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM threads WHERE id = OLD.owner_thread_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Prompt bakes are insert-only'
    USING ERRCODE = '23514', CONSTRAINT = 'prompt_bakes_insert_only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER prompt_bakes_insert_only
BEFORE UPDATE OR DELETE ON prompt_bakes
FOR EACH ROW EXECUTE FUNCTION enforce_prompt_bake_insert_only();
