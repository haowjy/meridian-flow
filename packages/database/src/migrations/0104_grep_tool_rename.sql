-- migration: no-transaction
-- migration: code 0104_grep_tool_rename.ts sha256:ea694e553421a7e8e55008230ea551fed05b07c96258fb04ff0993715aaffc1d
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM turn_blocks WHERE content->>'toolName' = 'search')
    OR EXISTS (SELECT 1 FROM thread_run_leases WHERE current_tool->>'toolName' = 'search') THEN
    RAISE EXCEPTION 'grep rename left a stored search call';
  END IF;
END
$$;
