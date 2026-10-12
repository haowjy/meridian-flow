-- Namespace observations have their own sequence; initialize above imported
-- pre-sequence evidence without changing availability's transaction grouping.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SELECT pg_advisory_xact_lock(1296387666, 1096174676);
--> statement-breakpoint
SELECT setval('context_namespace_observation_version_seq',
  greatest(1, (SELECT coalesce(max(namespace_generation), 0) FROM context_availability_heads)),
  true);
