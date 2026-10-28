-- migration: no-transaction
-- migration: code 0103_grep_tool_rename.ts sha256:84b8edc2d6647294df0c48e7da6ca9c6c10a48d1c0e26d7e2a8078944733ffb1
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM turn_blocks WHERE content->>'toolName' = 'search')
    OR EXISTS (SELECT 1 FROM thread_run_leases WHERE current_tool->>'toolName' = 'search') THEN
    RAISE EXCEPTION 'grep rename left a stored search call';
  END IF;
END
$$;
