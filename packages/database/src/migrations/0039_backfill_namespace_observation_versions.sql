-- Existing evidence predates the namespace watermark. Zero is deliberately older
-- than any issued observation, never a fabricated current version of historical data.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
UPDATE context_availability_heads SET namespace_generation = generation;
--> statement-breakpoint
UPDATE context_catalog_entries
SET entry = entry || '{"observationVersion":"0"}'::jsonb
WHERE entry->>'kind' IN ('file', 'folder');
--> statement-breakpoint
UPDATE context_catalog_commits
SET changes = (
  SELECT jsonb_agg(
    CASE WHEN change->>'operation' = 'upsert'
      AND change->'entry'->>'kind' IN ('file', 'folder')
    THEN jsonb_set(change, '{entry,observationVersion}', '"0"'::jsonb)
    ELSE change END ORDER BY ordinal
  )
  FROM jsonb_array_elements(changes) WITH ORDINALITY AS elements(change, ordinal)
);
--> statement-breakpoint
UPDATE context_operation_receipts
SET receipt = receipt || jsonb_build_object('observationVersion',
  CASE WHEN receipt->'command'->>'kind' = 'delete' AND receipt->'result'->>'ok' = 'true'
    THEN receipt->'result'->'value'->>'availabilityGeneration'
    ELSE '0' END);
--> statement-breakpoint
-- Namespace observations have their own sequence; initialize above imported
-- pre-sequence evidence without changing availability's transaction grouping.
SELECT pg_advisory_xact_lock(1296387666, 1096174676);
--> statement-breakpoint
SELECT setval('context_namespace_observation_version_seq',
  greatest(1, (SELECT coalesce(max(namespace_generation), 0) FROM context_availability_heads)),
  true);
