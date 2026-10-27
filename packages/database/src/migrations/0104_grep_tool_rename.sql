-- migration: no-transaction
-- migration: code 0104_grep_tool_rename.ts sha256:0a8824701d826f4bef71470272bf4c76755d843dcf47b9d1a92422ecdfd911ed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM turn_blocks WHERE content->>'toolName' = 'search')
    OR EXISTS (SELECT 1 FROM thread_run_leases WHERE current_tool->>'toolName' = 'search') THEN
    RAISE EXCEPTION 'grep rename left a stored search call';
  END IF;
END
$$;
