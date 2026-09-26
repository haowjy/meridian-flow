-- First bake is a CAS; after it, dynamic context belongs in conversation turns.
CREATE FUNCTION enforce_thread_prompt_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.baked_skill_slugs IS NOT NULL AND (
    NEW.composed_system_prompt IS DISTINCT FROM OLD.composed_system_prompt
    OR NEW.baked_skill_slugs IS DISTINCT FROM OLD.baked_skill_slugs
  ) THEN
    RAISE EXCEPTION 'Thread system prompt is frozen'
      USING ERRCODE = '23514', CONSTRAINT = 'threads_frozen_prompt';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER threads_frozen_prompt
BEFORE UPDATE OF composed_system_prompt, baked_skill_slugs ON threads
FOR EACH ROW EXECUTE FUNCTION enforce_thread_prompt_freeze();
