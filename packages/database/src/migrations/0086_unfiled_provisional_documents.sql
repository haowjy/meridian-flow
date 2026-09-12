-- Recover unfinished writing without moving ordinary Work resources or changing Yjs identity.
DO $$
DECLARE
  candidate record;
  destination uuid;
  filename text;
  basename text;
  old_path text;
  suffix integer;
BEGIN
  LOCK TABLE context_sources, documents, folders, works IN SHARE ROW EXCLUSIVE MODE;
  FOR candidate IN
    SELECT d.id, d.name, d.extension, d.folder_id, d.context_source_id,
           COALESCE(s.project_id, w.project_id) AS project_id
    FROM documents d
    JOIN context_sources s ON s.id = d.context_source_id
    LEFT JOIN works w ON w.id = s.work_id
    JOIN projects p ON p.id = COALESCE(s.project_id, w.project_id)
    WHERE d.kind = 'content' AND d.provisional_name AND d.deleted_at IS NULL
      AND s.slug = 'scratch' AND s.deleted_at IS NULL AND p.deleted_at IS NULL
      AND (s.work_id IS NULL OR w.deleted_at IS NULL)
    ORDER BY d.created_at, d.id
  LOOP
    SELECT id INTO destination FROM context_sources
      WHERE project_id = candidate.project_id AND slug = 'unfiled'
        AND work_id IS NULL AND deleted_at IS NULL;
    IF destination IS NULL THEN
      INSERT INTO context_sources (project_id, slug, name)
        VALUES (candidate.project_id, 'unfiled', 'Unfiled') RETURNING id INTO destination;
    END IF;

    WITH RECURSIVE parents AS (
      SELECT id, parent_id, name AS path FROM folders WHERE id = candidate.folder_id
      UNION ALL
      SELECT f.id, f.parent_id, f.name || '/' || p.path
        FROM folders f JOIN parents p ON f.id = p.parent_id
    )
    SELECT COALESCE((SELECT path || '/' FROM parents WHERE parent_id IS NULL), '')
      || candidate.name || CASE WHEN candidate.extension = '' THEN '' ELSE '.' || candidate.extension END
      INTO old_path;

    basename := candidate.name;
    suffix := 1;
    LOOP
      filename := basename || CASE WHEN candidate.extension = '' THEN '' ELSE '.' || candidate.extension END;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM documents WHERE context_source_id = destination AND folder_id IS NULL
          AND kind = 'content' AND deleted_at IS NULL AND name = basename AND extension = candidate.extension
      ) AND NOT EXISTS (
        SELECT 1 FROM folders WHERE context_source_id = destination AND parent_id IS NULL
          AND deleted_at IS NULL AND name = filename
      );
      basename := 'Untitled ' || suffix;
      suffix := suffix + 1;
    END LOOP;

    DELETE FROM document_previous_locations WHERE context_source_id = candidate.context_source_id AND path = old_path;
    INSERT INTO document_previous_locations (context_source_id, path, document_id)
      VALUES (candidate.context_source_id, old_path, candidate.id);
    DELETE FROM document_previous_locations WHERE context_source_id = destination AND path = filename;
    UPDATE documents SET context_source_id = destination, folder_id = NULL, name = basename,
      updated_at = now() WHERE id = candidate.id;

    -- Catalog checkpoints are derived. Rebuilding changes their generation and forces client reset.
    DELETE FROM context_catalog_scope_heads WHERE scope->>'projectId' = candidate.project_id::text;
    INSERT INTO context_availability_heads (authority_key, generation)
      VALUES ('project:' || candidate.project_id, nextval('context_availability_generation_seq'))
      ON CONFLICT (authority_key) DO UPDATE SET generation = EXCLUDED.generation, updated_at = now();
  END LOOP;
END $$;
