ALTER TABLE "threads" ADD COLUMN "baked_tools" jsonb;
--> statement-breakpoint
-- Extend the freeze trigger to cover the newly added baked_tools column: the
-- whole cached request prefix (prompt + tools) is fixed for the life of a
-- thread once baked_skill_slugs is non-null.
DROP TRIGGER threads_frozen_prompt ON threads;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_thread_prompt_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.baked_skill_slugs IS NOT NULL AND (
    NEW.composed_system_prompt IS DISTINCT FROM OLD.composed_system_prompt
    OR NEW.baked_skill_slugs IS DISTINCT FROM OLD.baked_skill_slugs
    OR NEW.baked_tools IS DISTINCT FROM OLD.baked_tools
  ) THEN
    RAISE EXCEPTION 'Thread system prompt is frozen'
      USING ERRCODE = '23514', CONSTRAINT = 'threads_frozen_prompt';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER threads_frozen_prompt
BEFORE UPDATE OF composed_system_prompt, baked_skill_slugs, baked_tools ON threads
FOR EACH ROW EXECUTE FUNCTION enforce_thread_prompt_freeze();
