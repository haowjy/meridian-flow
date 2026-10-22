-- Existing hidden draft nodes yield to the same deterministic namespace rule as live writes.
CREATE OR REPLACE FUNCTION pg_temp.mf_name_alias(kind text, filename text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN kind = 'folder'
    THEN regexp_replace(filename, '(?i)(\.(md|markdown|mdx|txt))+\s*$', '')
    ELSE filename
  END
$$;

DO $$
DECLARE
  node record;
  candidate text;
  candidate_name text;
  suffix integer;
  conflicts boolean;
BEGIN
  CREATE TEMP TABLE mf_accepted_names (
    context_source_id uuid NOT NULL,
    parent_id uuid,
    kind text NOT NULL,
    filename text NOT NULL
  ) ON COMMIT DROP;

  FOR node IN
    SELECT * FROM (
      SELECT d.id, d.context_source_id, d.folder_id AS parent_id, 'document'::text AS kind,
             d.name, d.extension, d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS filename,
             d.hidden, d.created_at
      FROM documents d WHERE d.deleted_at IS NULL
      UNION ALL
      SELECT f.id, f.context_source_id, f.parent_id, 'folder'::text, f.name, ''::text,
             f.name, f.hidden, f.created_at
      FROM folders f WHERE f.deleted_at IS NULL
    ) nodes
    ORDER BY context_source_id, parent_id NULLS FIRST,
             hidden ASC, (kind = 'folder') DESC, created_at ASC, id ASC
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM mf_accepted_names a
      WHERE a.context_source_id = node.context_source_id
        AND a.parent_id IS NOT DISTINCT FROM node.parent_id
        AND CASE WHEN a.kind = node.kind
          THEN a.filename = node.filename
          ELSE pg_temp.mf_name_alias(a.kind, a.filename) = pg_temp.mf_name_alias(node.kind, node.filename)
        END
    ) INTO conflicts;

    IF conflicts THEN
      suffix := 2;
      LOOP
        candidate_name := node.name || ' (' || suffix || ')';
        candidate := candidate_name || CASE WHEN node.kind = 'document' AND node.extension <> ''
          THEN '.' || node.extension ELSE '' END;
        SELECT EXISTS (
          SELECT 1 FROM (
            SELECT 'document'::text AS kind,
                   d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS filename
            FROM documents d
            WHERE d.deleted_at IS NULL AND d.context_source_id = node.context_source_id
              AND d.folder_id IS NOT DISTINCT FROM node.parent_id AND d.id <> node.id
            UNION ALL
            SELECT 'folder'::text, f.name FROM folders f
            WHERE f.deleted_at IS NULL AND f.context_source_id = node.context_source_id
              AND f.parent_id IS NOT DISTINCT FROM node.parent_id AND f.id <> node.id
          ) other
          WHERE CASE WHEN other.kind = node.kind
            THEN other.filename = candidate
            ELSE pg_temp.mf_name_alias(other.kind, other.filename) = pg_temp.mf_name_alias(node.kind, candidate)
          END
        ) INTO conflicts;
        EXIT WHEN NOT conflicts;
        suffix := suffix + 1;
      END LOOP;

      IF node.kind = 'document' THEN
        UPDATE documents SET name = candidate_name, updated_at = now(),
          location_version = location_version + 1 WHERE id = node.id;
      ELSE
        UPDATE folders SET name = candidate, updated_at = now(),
          location_version = location_version + 1 WHERE id = node.id;
        WITH RECURSIVE folder_tree(id) AS (
          SELECT node.id
          UNION ALL
          SELECT f.id FROM folders f JOIN folder_tree p ON f.parent_id = p.id
        )
        UPDATE folders SET location_version = location_version + 1
        WHERE id IN (SELECT id FROM folder_tree WHERE id <> node.id);
        WITH RECURSIVE folder_tree(id) AS (
          SELECT node.id
          UNION ALL
          SELECT f.id FROM folders f JOIN folder_tree p ON f.parent_id = p.id
        )
        UPDATE documents SET location_version = location_version + 1
        WHERE folder_id IN (SELECT id FROM folder_tree);
      END IF;
      node.filename := candidate;
    END IF;

    INSERT INTO mf_accepted_names VALUES (
      node.context_source_id, node.parent_id, node.kind, node.filename
    );
  END LOOP;
END $$;
