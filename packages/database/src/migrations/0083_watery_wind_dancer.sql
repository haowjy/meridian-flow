DROP INDEX "threads_project_slug_active";--> statement-breakpoint
DROP INDEX "projects_user_slug_active";--> statement-breakpoint
DROP INDEX "works_project_slug_active";--> statement-breakpoint
-- Reallocate project addresses deterministically; preserve existing live Work/chat
-- handles and disambiguate historical duplicates before reserving deleted rows.
DO $$
DECLARE
  item record;
  base text;
  candidate text;
  counter integer;
BEGIN
  CREATE TEMP TABLE allocated_project_handles (owner_id uuid, slug text, PRIMARY KEY (owner_id, slug)) ON COMMIT DROP;
  FOR item IN SELECT id, user_id, name FROM projects ORDER BY user_id, created_at, id LOOP
    base := trim(both '-' from left(trim(both '-' from regexp_replace(lower(regexp_replace(normalize(item.name, NFKD), U&'[\0300-\036f]', '', 'g')), '[^a-z0-9]+', '-', 'g')), 80));
    IF base = '' THEN base := 'project'; END IF;
    candidate := base;
    counter := 2;
    WHILE EXISTS (SELECT 1 FROM allocated_project_handles WHERE owner_id = item.user_id AND slug = candidate) LOOP
      candidate := base || '-' || counter;
      counter := counter + 1;
    END LOOP;
    INSERT INTO allocated_project_handles VALUES (item.user_id, candidate);
    UPDATE projects SET slug = candidate WHERE id = item.id;
  END LOOP;

  CREATE TEMP TABLE allocated_work_handles (project_id uuid, slug text, PRIMARY KEY (project_id, slug)) ON COMMIT DROP;
  FOR item IN SELECT id, project_id, slug FROM works ORDER BY project_id, (deleted_at IS NOT NULL), created_at, id LOOP
    base := item.slug;
    candidate := base;
    counter := 2;
    WHILE EXISTS (SELECT 1 FROM allocated_work_handles WHERE project_id = item.project_id AND slug = candidate)
      OR (candidate <> base AND EXISTS (SELECT 1 FROM works WHERE project_id = item.project_id AND id <> item.id AND slug = candidate)) LOOP
      candidate := base || '-' || counter;
      counter := counter + 1;
    END LOOP;
    INSERT INTO allocated_work_handles VALUES (item.project_id, candidate);
    UPDATE works SET slug = candidate WHERE id = item.id;
  END LOOP;

  CREATE TEMP TABLE allocated_chat_handles (project_id uuid, slug text, PRIMARY KEY (project_id, slug)) ON COMMIT DROP;
  FOR item IN SELECT id, project_id, slug, title FROM threads ORDER BY project_id, (slug IS NULL), (deleted_at IS NOT NULL), created_at, id LOOP
    base := item.slug;
    IF base IS NULL THEN
      IF btrim(item.title) = '' THEN
        base := 'chat';
      ELSE
        base := trim(both '-' from left(trim(both '-' from regexp_replace(lower(regexp_replace(normalize(item.title, NFKD), U&'[\0300-\036f]', '', 'g')), '[^a-z0-9]+', '-', 'g')), 80));
        IF base = '' THEN base := 'thread'; END IF;
      END IF;
    END IF;
    candidate := base;
    counter := 2;
    WHILE EXISTS (SELECT 1 FROM allocated_chat_handles WHERE project_id = item.project_id AND slug = candidate)
      OR (candidate <> item.slug OR item.slug IS NULL) AND EXISTS (SELECT 1 FROM threads WHERE project_id = item.project_id AND id <> item.id AND slug = candidate) LOOP
      candidate := base || '-' || counter;
      counter := counter + 1;
    END LOOP;
    INSERT INTO allocated_chat_handles VALUES (item.project_id, candidate);
    UPDATE threads SET slug = candidate WHERE id = item.id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "threads_project_slug" ON "threads" USING btree ("project_id","slug") WHERE "threads"."slug" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release namespace reallocation and reservation must commit atomically)--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_slug" ON "projects" USING btree ("user_id","slug"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release namespace reallocation and reservation must commit atomically)--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_slug" ON "works" USING btree ("project_id","slug"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release namespace reallocation and reservation must commit atomically)
