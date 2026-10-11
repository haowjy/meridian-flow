-- One canonical name per content document. The suffix registry is a point-in-time copy.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "extension" SET DEFAULT '';
--> statement-breakpoint
CREATE TEMP TABLE document_name_registry (extension text PRIMARY KEY, filetype text NOT NULL) ON COMMIT DROP;
INSERT INTO document_name_registry VALUES
 ('md','markdown'),('markdown','markdown'),('mdx','markdown'),('txt','markdown'),
 ('py','python'),('ts','typescript'),('tsx','typescript'),('js','javascript'),('jsx','javascript'),
 ('json','json'),('sh','shell'),('yaml','yaml'),('yml','yaml'),('csv','csv'),('toml','text'),('xml','text'),
 ('ipynb','notebook'),('pdf','pdf'),('png','png'),('jpg','jpg'),('jpeg','jpg'),('svg','svg');
--> statement-breakpoint
-- The SQL snapshot of the codec also owns folder comparison (literal spelling is unchanged).
CREATE FUNCTION pg_temp.document_folder_key(input text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n text := btrim(input); e text := ''; suffix text;
BEGIN
 suffix := lower(substring(n FROM '[.]([^.]*)$'));
 IF EXISTS (SELECT 1 FROM document_name_registry WHERE extension = suffix) THEN
  e := suffix; n := btrim(left(n, length(n) - length(suffix) - 1));
 END IF;
 IF EXISTS (SELECT 1 FROM document_name_registry WHERE extension = e AND filetype = 'markdown') THEN
  e := '';
  LOOP
   suffix := lower(substring(n FROM '[.]([^.]*)$'));
   EXIT WHEN NOT EXISTS (SELECT 1 FROM document_name_registry WHERE extension = suffix AND filetype = 'markdown');
   n := btrim(left(n, length(n) - length(suffix) - 1));
  END LOOP;
 END IF;
 suffix := lower(substring(n FROM '[.]([^.]*)$'));
 IF n IN ('', '.', '..') OR (e = '' AND EXISTS (
   SELECT 1 FROM document_name_registry WHERE extension = suffix AND filetype <> 'markdown'
 )) THEN RETURN input; END IF;
 RETURN n || CASE WHEN e = '' THEN '' ELSE '.' || e END;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE document_name_changes ON COMMIT DROP AS
WITH RECURSIVE folder_paths AS (
 SELECT id, name AS path FROM folders WHERE parent_id IS NULL
 UNION ALL SELECT f.id, p.path || '/' || f.name FROM folders f JOIN folder_paths p ON f.parent_id = p.id
)
SELECT d.id, d.context_source_id, d.folder_id, d.deleted_at, d.deleted_by_work_id,
 d.name AS old_name, d.extension AS old_extension, d.file_type AS old_type,
 coalesce(p.path || '/', '') AS prefix,
 d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS old_basename,
 d.name AS name, d.extension AS extension, d.file_type AS filetype,
 false AS allocated
FROM documents d LEFT JOIN folder_paths p ON p.id = d.folder_id WHERE d.kind = 'content';
--> statement-breakpoint
-- Reservations without a content row participate in the same canonical allocation.
INSERT INTO document_name_changes
SELECT u.document_id, u.context_source_id, f.id, NULL::timestamptz, NULL::uuid,
 CASE WHEN registry.extension IS NULL THEN basename ELSE left(basename, length(basename) - length(registry.extension) - 1) END,
 coalesce(registry.extension, ''), u.file_type, prefix, basename,
 basename, '', u.file_type, false
FROM upload_intakes u
CROSS JOIN LATERAL (SELECT regexp_replace(u.final_path, '[^/]*$', '') AS prefix,
 substring(u.final_path FROM '[^/]*$') AS basename) path
LEFT JOIN document_name_registry registry ON registry.extension = lower(substring(basename FROM '[.]([^.]*)$'))
LEFT JOIN (
 WITH RECURSIVE paths AS (
  SELECT id, context_source_id, name AS path FROM folders WHERE parent_id IS NULL
  UNION ALL SELECT f.id, f.context_source_id, p.path || '/' || f.name FROM folders f JOIN paths p ON p.id = f.parent_id
 ) SELECT * FROM paths
) f ON f.context_source_id = u.context_source_id AND f.path || '/' = prefix
WHERE u.state IN ('reserved', 'object_stored') AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = u.document_id);
--> statement-breakpoint
DO $$
DECLARE r record; n text; e text; t text; suffix text; is_binary boolean; binary_type text; candidate text; number integer;
BEGIN
 FOR r IN SELECT c.*, d.storage_url, coalesce(d.mime_type, u.mime_type) AS mime_type FROM document_name_changes c LEFT JOIN documents d ON d.id = c.id LEFT JOIN upload_intakes u ON u.document_id = c.id LOOP
  is_binary := r.storage_url IS NOT NULL OR r.old_type IN ('pdf','image','binary','docx','png','jpg','svg','notebook');
  n := btrim(r.old_name); e := lower(r.old_extension); t := r.old_type;
  IF NOT EXISTS (SELECT 1 FROM document_name_registry WHERE extension = e) THEN
   n := btrim(r.old_name || CASE WHEN r.old_extension = '' THEN '' ELSE '.' || r.old_extension END); e := '';
  END IF;
  IF (NOT is_binary AND r.old_type = 'markdown') OR e IN ('md','markdown','mdx','txt') OR e = '' THEN
   IF e <> '' AND e NOT IN ('md','markdown','mdx','txt') THEN n := n || '.' || e; END IF;
   e := ''; IF NOT is_binary THEN t := 'markdown'; END IF;
   LOOP
    suffix := lower(substring(n FROM '[.]([^.]*)$'));
    EXIT WHEN suffix IS NULL OR suffix NOT IN ('md','markdown','mdx','txt');
    n := btrim(left(n, length(n) - length(suffix) - 1));
   END LOOP;
  ELSIF NOT is_binary THEN
   SELECT filetype INTO t FROM document_name_registry WHERE extension = e;
  END IF;
  -- D17: bytes with a prose name take the storage type's registered suffix, if any.
  IF is_binary AND e = '' THEN
   binary_type := CASE lower(split_part(coalesce(r.mime_type, ''), ';', 1))
    WHEN 'application/pdf' THEN 'pdf' WHEN 'image/png' THEN 'png'
    WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/svg+xml' THEN 'svg'
    ELSE r.old_type END;
   SELECT extension INTO e FROM document_name_registry WHERE filetype = binary_type
    ORDER BY CASE WHEN extension = 'jpeg' THEN 1 ELSE 0 END, extension LIMIT 1;
   e := coalesce(e, '');
  END IF;
  IF n IN ('', '.', '..') THEN n := 'Untitled'; END IF;
  UPDATE document_name_changes SET name = n, extension = e, filetype = t WHERE id = r.id;
 END LOOP;
 -- Canonical existing names win, then UUID order. Reserve every desired name before allocating
 -- a suffix so a twin cannot steal a legitimate "Chapter (2)". Folders always win.
 FOR r IN SELECT * FROM document_name_changes ORDER BY deleted_at IS NOT NULL,
   (old_name = name AND old_extension = extension) DESC,
   EXISTS (SELECT 1 FROM documents d WHERE d.id = document_name_changes.id) DESC, id LOOP
  n := r.name; e := r.extension; candidate := n; number := 1;
  LOOP
   suffix := lower(substring(candidate FROM '[.]([^.]*)$'));
   EXIT WHEN NOT (
    (e = '' AND EXISTS (SELECT 1 FROM document_name_registry WHERE extension = suffix AND filetype <> 'markdown'))
    OR EXISTS (SELECT 1 FROM folders f WHERE f.context_source_id = r.context_source_id
      AND f.parent_id IS NOT DISTINCT FROM r.folder_id AND (f.deleted_at IS NULL OR f.deleted_by_work_id = r.deleted_by_work_id)
      AND pg_temp.document_folder_key(f.name) = candidate || CASE WHEN e = '' THEN '' ELSE '.' || e END)
    OR EXISTS (SELECT 1 FROM document_name_changes c
      WHERE c.id <> r.id AND c.context_source_id = r.context_source_id
      AND c.folder_id IS NOT DISTINCT FROM r.folder_id
      AND (c.deleted_at IS NULL OR (r.deleted_by_work_id IS NOT NULL AND c.deleted_by_work_id = r.deleted_by_work_id))
      AND c.extension = e AND c.name = candidate AND (c.allocated OR number > 1))
    -- Intakes own a second, case-folded namespace. Pending reservations have no content row.
    OR (EXISTS (SELECT 1 FROM upload_intakes u WHERE u.document_id = r.id AND u.state <> 'deleted')
      AND (
       EXISTS (SELECT 1 FROM upload_intakes u WHERE u.context_source_id = r.context_source_id
         AND u.document_id <> r.id AND u.state <> 'deleted'
         AND NOT EXISTS (SELECT 1 FROM document_name_changes c WHERE c.id = u.document_id)
         AND lower(u.final_path) = lower(r.prefix || candidate || CASE WHEN e = '' THEN '' ELSE '.' || e END))
       OR EXISTS (SELECT 1 FROM document_name_changes c JOIN upload_intakes u ON u.document_id = c.id
         WHERE c.id <> r.id AND u.context_source_id = r.context_source_id AND u.state <> 'deleted'
         AND lower(c.prefix || c.name || CASE WHEN c.extension = '' THEN '' ELSE '.' || c.extension END)
           = lower(r.prefix || candidate || CASE WHEN e = '' THEN '' ELSE '.' || e END)
         AND (c.allocated OR number > 1))
      ))
   );
   number := number + 1; candidate := n || ' (' || number || ')';
  END LOOP;
  UPDATE document_name_changes SET name = candidate, allocated = true WHERE id = r.id;
 END LOOP;
 -- Stage all rows out of the live unique indexes before the canonical assignments.
 -- UUID staging names are reserved against both current and final names, not assumed absent.
 FOR r IN SELECT * FROM document_name_changes ORDER BY id LOOP
  candidate := '__document_name_migration_' || r.id; number := 1;
  WHILE EXISTS (SELECT 1 FROM documents WHERE context_source_id = r.context_source_id
    AND folder_id IS NOT DISTINCT FROM r.folder_id AND name = candidate AND extension = '' AND deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM document_name_changes WHERE context_source_id = r.context_source_id
    AND folder_id IS NOT DISTINCT FROM r.folder_id AND name = candidate AND extension = '' AND deleted_at IS NULL)
  LOOP number := number + 1; candidate := '__document_name_migration_' || r.id || '_' || number; END LOOP;
  UPDATE documents SET name = candidate, extension = '' WHERE id = r.id;
 END LOOP;
 UPDATE documents d SET name = c.name, extension = c.extension, file_type = c.filetype,
  location_version = d.location_version + CASE WHEN c.old_name <> c.name OR c.old_extension <> c.extension THEN 1 ELSE 0 END
 FROM document_name_changes c WHERE d.id = c.id;
END $$;
--> statement-breakpoint
-- Identity-bound historical aliases preserve their folder prefix; only the document basename
-- changes. Ahead refs and recovery addresses that exactly named an old row follow its rename.
CREATE TEMP TABLE document_address_changes (kind text, id text, old_address text, address text) ON COMMIT DROP;
INSERT INTO document_address_changes
 SELECT 'previous', ctid::text, path, path FROM document_previous_locations
 UNION ALL SELECT 'ahead', ahead_id::text, path, path FROM link_ahead_refs
 UNION ALL SELECT 'link', ctid::text, address, address FROM document_links WHERE address IS NOT NULL
 UNION ALL SELECT 'upload', u.document_id::text, u.final_path, u.final_path FROM upload_intakes u WHERE EXISTS (SELECT 1 FROM document_name_changes c WHERE c.id = u.document_id)
 UNION ALL SELECT 'upload-uri', u.document_id::text, u.canonical_uri, u.canonical_uri FROM upload_intakes u WHERE EXISTS (SELECT 1 FROM document_name_changes c WHERE c.id = u.document_id)
 UNION ALL SELECT 'result-uri', id::text, results_uri, results_uri FROM project_results WHERE results_uri ~ '^(manuscript|kb|user|unfiled|scratch|uploads)://';
--> statement-breakpoint
DO $$
DECLARE r record; mapped text; input text; prefix text; n text; e text; suffix text; t text; source uuid; target uuid;
BEGIN
 FOR r IN SELECT * FROM document_address_changes LOOP
  input := r.old_address; mapped := NULL; source := NULL; target := NULL;
  IF r.kind = 'previous' THEN
   SELECT context_source_id, document_id INTO source, target FROM document_previous_locations WHERE ctid = r.id::tid;
  ELSIF r.kind = 'upload' THEN
   SELECT context_source_id, document_id INTO source, target FROM upload_intakes WHERE document_id = r.id::uuid;
  ELSIF r.kind = 'upload-uri' THEN
   SELECT document_id INTO target FROM upload_intakes WHERE document_id = r.id::uuid;
  ELSIF r.kind = 'ahead' THEN
   SELECT s.id, a.settled_document_id INTO source, target FROM link_ahead_refs a JOIN context_sources s
    ON (
      coalesce(s.project_id, (SELECT w.project_id FROM works w WHERE w.id = s.work_id)) = a.project_id
      OR (a.scheme = 'user' AND EXISTS (SELECT 1 FROM projects holder JOIN projects personal
        ON personal.user_id = holder.user_id AND personal.is_personal WHERE holder.id = a.project_id AND personal.id = s.project_id))
    ) AND s.slug = a.scheme AND s.work_id IS NOT DISTINCT FROM a.work_id
    AND s.root_thread_id IS NOT DISTINCT FROM a.root_thread_id WHERE a.ahead_id = r.id::uuid LIMIT 1;
  END IF;
  IF r.kind = 'link' THEN
   SELECT coalesce(l.target_document_id, a.settled_document_id) INTO target FROM document_links l
    LEFT JOIN link_ahead_refs a ON a.ahead_id = l.ahead_id WHERE l.ctid = r.id::tid;
  END IF;
  IF target IS NOT NULL AND r.kind IN ('link','upload-uri','previous') THEN
   SELECT regexp_replace(input, '[^/]*$', '') || name || CASE WHEN extension = '' THEN '' ELSE '.' || extension END
    INTO mapped FROM document_name_changes WHERE id = target AND old_basename = substring(input FROM '[^/]*$');
  END IF;
  IF source IS NOT NULL AND mapped IS NULL THEN
   SELECT c.prefix || c.name || CASE WHEN c.extension = '' THEN '' ELSE '.' || c.extension END INTO mapped
    FROM document_name_changes c WHERE c.context_source_id = source AND c.prefix || c.old_basename = input
    AND (target IS NULL OR c.id = target) ORDER BY c.deleted_at IS NOT NULL, c.id LIMIT 1;
  END IF;
  IF mapped IS NULL THEN
   prefix := regexp_replace(input, '[^/]*$', ''); n := btrim(substring(input FROM '[^/]*$')); e := '';
   suffix := lower(substring(n FROM '[.]([^.]*)$'));
   IF EXISTS (SELECT 1 FROM document_name_registry WHERE extension = suffix) THEN
    e := suffix; n := btrim(left(n, length(n) - length(suffix) - 1));
   END IF;
   IF e IN ('md','markdown','mdx','txt') THEN
    e := '';
    LOOP
     suffix := lower(substring(n FROM '[.]([^.]*)$'));
     EXIT WHEN suffix IS NULL OR suffix NOT IN ('md','markdown','mdx','txt');
     n := btrim(left(n, length(n) - length(suffix) - 1));
    END LOOP;
   END IF;
   mapped := prefix || n || CASE WHEN e = '' THEN '' ELSE '.' || e END;
  END IF;
  UPDATE document_address_changes SET address = mapped WHERE kind = r.kind AND id = r.id;
 END LOOP;
 UPDATE document_previous_locations p SET path = a.address FROM document_address_changes a WHERE a.kind = 'previous' AND p.ctid = a.id::tid;
 UPDATE link_ahead_refs p SET path = a.address FROM document_address_changes a WHERE a.kind = 'ahead' AND p.ahead_id = a.id::uuid;
 UPDATE document_address_changes c SET address = regexp_replace(c.old_address, '[^/]*$', '') || substring(a.address FROM '[^/]*$')
 FROM document_links l JOIN document_address_changes a ON a.kind = 'ahead' AND a.id = l.ahead_id::text
 WHERE c.kind = 'link' AND l.ctid = c.id::tid;
 UPDATE document_links p SET address = a.address FROM document_address_changes a WHERE a.kind = 'link' AND p.ctid = a.id::tid;
 UPDATE upload_intakes p SET canonical_uri = a.address FROM document_address_changes a WHERE a.kind = 'upload-uri' AND p.document_id = a.id::uuid;
 UPDATE project_results p SET results_uri = a.address FROM document_address_changes a WHERE a.kind = 'result-uri' AND p.id = a.id::uuid;
 -- Stage identity-backed intake paths before swapping their final assignments.
 FOR r IN SELECT a.* FROM document_address_changes a WHERE a.kind = 'upload' ORDER BY a.id LOOP
  mapped := '__document_name_intake_' || r.id;
  WHILE EXISTS (SELECT 1 FROM upload_intakes u WHERE lower(u.final_path) = lower(mapped))
    OR EXISTS (SELECT 1 FROM document_address_changes a WHERE a.kind = 'upload' AND lower(a.address) = lower(mapped))
  LOOP mapped := mapped || '_'; END LOOP;
  UPDATE upload_intakes SET final_path = mapped WHERE document_id = r.id::uuid;
 END LOOP;
 UPDATE upload_intakes p SET final_path = a.address FROM document_address_changes a WHERE a.kind = 'upload' AND p.document_id = a.id::uuid;
END $$;

--> statement-breakpoint
WITH rewritten AS (
 SELECT w.user_id, w.project_id, jsonb_agg(
   CASE WHEN c.id IS NULL THEN route.value
    ELSE jsonb_set(route.value, '{path}', to_jsonb(c.prefix || c.name ||
      CASE WHEN c.extension = '' THEN '' ELSE '.' || c.extension END)) END ORDER BY route.ordinality
 ) AS routes
 FROM project_user_working_sets w
 CROSS JOIN LATERAL jsonb_array_elements(w.recent_routes) WITH ORDINALITY AS route(value, ordinality)
 LEFT JOIN document_name_changes c ON c.id::text = route.value->>'documentId'
 GROUP BY w.user_id, w.project_id
)
UPDATE project_user_working_sets w SET recent_routes = r.routes, revision = w.revision + 1, updated_at = now()
FROM rewritten r WHERE w.user_id = r.user_id AND w.project_id = r.project_id AND w.recent_routes IS DISTINCT FROM r.routes;

--> statement-breakpoint
-- Catalog entries/commits are derived address checkpoints, not writer content. Fence old
-- cursors instead of letting an old delta replay resurrect pre-migration document names.
DELETE FROM context_catalog_commits; -- migration-lint: skip DELETE_WITHOUT_WHERE (all rows are derived replay checkpoints; the generation reset forces canonical snapshots, and no writer content is removed)
DELETE FROM context_catalog_entries; -- migration-lint: skip DELETE_WITHOUT_WHERE (all rows are derived metadata checkpoints rebuilt from document identity, not writer content)
UPDATE context_catalog_scope_heads SET generation = gen_random_uuid(), head_revision = 0, oldest_revision = 1; -- migration-lint: skip UPDATE_WITHOUT_WHERE (every catalog scope must fence its pre-migration replay cursor)
UPDATE context_availability_heads SET generation = nextval('context_availability_generation_seq'); -- migration-lint: skip UPDATE_WITHOUT_WHERE (every cached availability scope must revalidate the rewritten addresses)
