-- =============================================================================
-- One-time fix: Prefix all index names with environment prefix
-- =============================================================================
-- Problem: Index names like idx_projects_user_name are globally unique in
-- the public schema. Since dev_, test_, prod_ environments share the same
-- Supabase database, only one environment can own each index name.
--
-- Solution: Rename idx_foo on dev_table → idx_dev_foo, and create
-- corresponding indexes for other environments whose tables exist.
--
-- Run this ONCE in the Supabase SQL Editor, then update migration files.
-- =============================================================================

DO $$
DECLARE
    idx RECORD;
    owner_prefix TEXT;
    env TEXT;
    env_prefixes TEXT[] := ARRAY['dev_', 'test_', 'prod_'];
    new_index_name TEXT;
    new_table_name TEXT;
    new_indexdef TEXT;
    existing_table_name TEXT;
    suffix TEXT;  -- the part after idx_ (e.g., "projects_user_name")
BEGIN
    -- =========================================================================
    -- Step 1: Rename unprefixed indexes and create for other environments
    -- =========================================================================
    FOR idx IN
        SELECT indexname, tablename, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname LIKE 'idx_%'
          -- Skip already-prefixed indexes
          AND indexname NOT LIKE 'idx_dev_%'
          AND indexname NOT LIKE 'idx_test_%'
          AND indexname NOT LIKE 'idx_prod_%'
    LOOP
        -- Determine the owner env prefix from the table name
        owner_prefix := NULL;
        FOREACH env IN ARRAY env_prefixes LOOP
            IF idx.tablename LIKE env || '%' THEN
                owner_prefix := env;
                EXIT;
            END IF;
        END LOOP;

        -- Skip indexes on non-prefixed tables (shouldn't exist, but be safe)
        IF owner_prefix IS NULL THEN
            RAISE NOTICE 'Skipping index % on non-prefixed table %', idx.indexname, idx.tablename;
            CONTINUE;
        END IF;

        -- Extract suffix: idx_projects_user_name → projects_user_name
        suffix := substring(idx.indexname FROM 5);  -- strip 'idx_'

        -- Rename existing index if target name is free.
        -- If target already exists on the same table, unprefixed index is orphaned/duplicate.
        new_index_name := 'idx_' || owner_prefix || suffix;
        IF new_index_name != idx.indexname THEN
            SELECT tablename
            INTO existing_table_name
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = new_index_name
            LIMIT 1;

            IF existing_table_name IS NULL THEN
                EXECUTE format('ALTER INDEX %I RENAME TO %I', idx.indexname, new_index_name);
                RAISE NOTICE 'Renamed: % → %', idx.indexname, new_index_name;
            ELSIF existing_table_name = idx.tablename THEN
                EXECUTE format('DROP INDEX IF EXISTS %I', idx.indexname);
                RAISE NOTICE 'Dropped duplicate/orphaned unprefixed index: % (kept %)', idx.indexname, new_index_name;
            ELSE
                RAISE NOTICE 'Skipping rename for %: target % exists on different table %',
                    idx.indexname, new_index_name, existing_table_name;
            END IF;
        END IF;

        -- Create corresponding indexes for OTHER environments
        FOREACH env IN ARRAY env_prefixes LOOP
            IF env = owner_prefix THEN
                CONTINUE;  -- Already handled above
            END IF;

            -- Check if the target table exists for this env
            new_table_name := env || substring(idx.tablename FROM length(owner_prefix) + 1);
            IF NOT EXISTS (
                SELECT 1 FROM pg_tables
                WHERE schemaname = 'public' AND tablename = new_table_name
            ) THEN
                CONTINUE;  -- Table doesn't exist for this env
            END IF;

            -- Build new CREATE INDEX statement by replacing names in indexdef
            -- Replace index name first, then table name
            new_indexdef := replace(idx.indexdef, idx.indexname, 'idx_' || env || suffix);
            new_indexdef := replace(new_indexdef, idx.tablename, new_table_name);

            -- Create if not exists (use IF NOT EXISTS by injecting after CREATE)
            -- indexdef looks like: CREATE INDEX idx_foo ON public.table ...
            -- or: CREATE UNIQUE INDEX idx_foo ON public.table ...
            new_indexdef := replace(new_indexdef, 'CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ');
            new_indexdef := replace(new_indexdef, 'CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ');

            BEGIN
                EXECUTE new_indexdef;
                RAISE NOTICE 'Created: idx_%', env || suffix;
            EXCEPTION WHEN duplicate_table THEN
                RAISE NOTICE 'Already exists: idx_%', env || suffix;
            END;
        END LOOP;
    END LOOP;

    -- =========================================================================
    -- Step 2: Drop orphaned index from migration 00009/00012 mismatch
    -- =========================================================================
    -- Legacy cleanup for environments where this unprefixed index still exists.
    -- Safe no-op when already renamed/dropped above.
    DROP INDEX IF EXISTS idx_project_skills_name;
    RAISE NOTICE 'Dropped orphaned: idx_project_skills_name (if it existed)';

    RAISE NOTICE 'Done! All indexes are now environment-prefixed.';
END $$;
