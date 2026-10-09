-- Archive every old No Work Scratch tree without rewriting collaborative content.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- Acquire the same namespace locks as app moves, in their canonical order.
SELECT pg_advisory_xact_lock(hashtextextended(key, 0::bigint))
FROM (
  SELECT DISTINCT 'context-project:' || w.project_id || ':' || w.id || ':scratch' AS key
  FROM context_sources s JOIN works w ON w.id = s.work_id
  WHERE w.is_no_work AND s.slug = 'scratch'
  UNION
  SELECT DISTINCT 'context-project:' || w.project_id || ':none:unfiled'
  FROM context_sources s JOIN works w ON w.id = s.work_id
  WHERE w.is_no_work AND s.slug = 'scratch'
) namespaces ORDER BY key;
--> statement-breakpoint
-- Match ensureProjectContextSource: all other columns use their schema defaults.
INSERT INTO context_sources (project_id, name, slug, scope, adapter_type)
SELECT DISTINCT w.project_id, 'Unfiled', 'unfiled', 'project', 'local'
FROM context_sources s JOIN works w ON w.id = s.work_id
WHERE w.is_no_work AND s.slug = 'scratch'
  AND NOT EXISTS (
    SELECT 1 FROM context_sources dest
    WHERE dest.project_id = w.project_id AND dest.slug = 'unfiled'
      AND dest.work_id IS NULL AND dest.root_thread_id IS NULL AND dest.deleted_at IS NULL
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Never reuse a root entry, even a trashed one. Allocate one fresh root per
-- historical source, ordered by identity, using the app's "name (2)" convention.
CREATE TEMP TABLE scratch_archive_moves ON COMMIT DROP AS
WITH sources AS (
  SELECT s.id AS old_id, w.id AS work_id, w.project_id, dest.id AS destination_id,
    row_number() OVER (PARTITION BY dest.id ORDER BY s.id) AS ordinal,
    count(*) OVER (PARTITION BY dest.id) AS source_count
  FROM context_sources s JOIN works w ON w.id = s.work_id
  JOIN context_sources dest ON dest.project_id = w.project_id
    AND dest.slug = 'unfiled' AND dest.work_id IS NULL
    AND dest.root_thread_id IS NULL AND dest.deleted_at IS NULL
  WHERE w.is_no_work AND s.slug = 'scratch'
), occupied AS (
  SELECT context_source_id AS source_id, name FROM folders WHERE parent_id IS NULL
  UNION
  SELECT context_source_id, name || CASE WHEN extension = '' THEN '' ELSE '.' || extension END
  FROM documents WHERE folder_id IS NULL
  UNION
  SELECT context_source_id, split_part(final_path, '/', 1) FROM upload_intakes
), destinations AS (
  SELECT DISTINCT destination_id, source_count FROM sources
), candidates AS (
  SELECT d.destination_id, n,
    CASE WHEN n = 1 THEN 'Scratch' ELSE 'Scratch (' || n || ')' END AS name
  FROM destinations d
  CROSS JOIN LATERAL generate_series(1,
    (d.source_count + (SELECT count(*) FROM occupied o WHERE o.source_id = d.destination_id))::integer
  ) n
), free_names AS (
  SELECT c.*, row_number() OVER (PARTITION BY destination_id ORDER BY n) AS ordinal
  FROM candidates c
  WHERE NOT EXISTS (SELECT 1 FROM occupied o WHERE o.source_id = c.destination_id AND o.name = c.name)
)
SELECT s.old_id, s.work_id, s.project_id, s.destination_id,
  gen_random_uuid() AS folder_id, f.name AS folder_name
FROM sources s JOIN free_names f ON f.destination_id = s.destination_id AND f.ordinal = s.ordinal;
--> statement-breakpoint
INSERT INTO folders (id, context_source_id, parent_id, name)
SELECT folder_id, destination_id, NULL, folder_name FROM scratch_archive_moves;
--> statement-breakpoint
UPDATE folders f SET context_source_id = m.destination_id,
  parent_id = coalesce(f.parent_id, m.folder_id), updated_at = now()
FROM scratch_archive_moves m WHERE f.context_source_id = m.old_id;
--> statement-breakpoint
UPDATE documents d SET context_source_id = m.destination_id,
  folder_id = coalesce(d.folder_id, m.folder_id),
  location_version = d.location_version + 1, updated_at = now()
FROM scratch_archive_moves m WHERE d.context_source_id = m.old_id;
--> statement-breakpoint
-- Claim the newly occupied destination paths, consuming old identity aliases
-- there just as recordDocumentMove does. Only live, traversable occupants claim
-- aliases; trashed content still moves without consuming unrelated history.
WITH RECURSIVE paths AS (
  SELECT f.id, f.context_source_id, f.name AS path
  FROM folders f JOIN scratch_archive_moves m ON m.folder_id = f.id
  WHERE f.deleted_at IS NULL
  UNION ALL
  SELECT f.id, f.context_source_id, p.path || '/' || f.name
  FROM folders f JOIN paths p ON f.parent_id = p.id AND f.context_source_id = p.context_source_id
  WHERE f.deleted_at IS NULL
), occupied AS (
  SELECT context_source_id, path FROM paths
  UNION ALL
  SELECT d.context_source_id, p.path || '/' || d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END
  FROM documents d JOIN paths p ON d.folder_id = p.id AND d.context_source_id = p.context_source_id
  WHERE d.deleted_at IS NULL AND d.kind = 'content'
)
DELETE FROM document_previous_locations l USING occupied o
WHERE l.context_source_id = o.context_source_id AND l.path = o.path;
--> statement-breakpoint
-- Object keys are project/document-ID-based, not source/path-based. Keep them,
-- fingerprints, bytes, intake identities and Work lifecycle ownership; invalidate
-- stale location tokens. Unfiled is the destination, not a new intake owner.
UPDATE upload_intakes u SET context_source_id = m.destination_id,
  final_path = m.folder_name || '/' || u.final_path,
  canonical_uri = 'unfiled://' || m.folder_name || '/' || u.final_path,
  location_revision = gen_random_uuid(), updated_at = now()
FROM scratch_archive_moves m WHERE u.context_source_id = m.old_id;
--> statement-breakpoint
-- Deleting heads cascades entries and replay commits. The next catalog snapshot
-- builds from current rows under a fresh generation, invalidating old cursors.
DELETE FROM context_catalog_scope_heads h USING scratch_archive_moves m
WHERE h.scope_key IN ('project:' || m.project_id, 'work:' || m.project_id || ':' || m.work_id);
--> statement-breakpoint
-- Old scratch://@/... previous-location rows intentionally disappear with their
-- source. This round does NOT repair stored links or write identity redirects:
-- legacy href continuity is parked pending the owner decision / PR #737.
-- The guard makes content/intake cascades impossible even if a writer raced us.
DELETE FROM context_sources s USING scratch_archive_moves m
WHERE s.id = m.old_id
  AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.context_source_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.context_source_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM upload_intakes u WHERE u.context_source_id = s.id);
