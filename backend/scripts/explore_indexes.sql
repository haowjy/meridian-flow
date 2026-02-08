-- =============================================================================
-- Diagnostic: Explore all indexes in the public schema
-- Paste into Supabase SQL Editor to see the current state
-- =============================================================================

-- 1. All custom indexes (non-pkey), grouped by prefix status
SELECT
    CASE
        WHEN indexname LIKE 'idx_dev_%' THEN 'dev_prefixed'
        WHEN indexname LIKE 'idx_test_%' THEN 'test_prefixed'
        WHEN indexname LIKE 'idx_prod_%' THEN 'prod_prefixed'
        WHEN indexname LIKE 'idx_%' THEN '⚠️ UNPREFIXED'
        ELSE 'other'
    END AS status,
    indexname,
    tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname NOT LIKE '%_pkey'
ORDER BY status, indexname;

-- 2. Tables by environment
SELECT
    CASE
        WHEN tablename LIKE 'dev_%' THEN 'dev'
        WHEN tablename LIKE 'test_%' THEN 'test'
        WHEN tablename LIKE 'prod_%' THEN 'prod'
        ELSE 'other'
    END AS env,
    tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY env, tablename;

-- 3. Orphaned indexes: index name suggests one env but table belongs to another
SELECT
    indexname,
    tablename,
    CASE
        WHEN tablename LIKE 'dev_%' THEN 'dev'
        WHEN tablename LIKE 'test_%' THEN 'test'
        WHEN tablename LIKE 'prod_%' THEN 'prod'
    END AS table_env,
    CASE
        WHEN indexname LIKE 'idx_dev_%' THEN 'dev'
        WHEN indexname LIKE 'idx_test_%' THEN 'test'
        WHEN indexname LIKE 'idx_prod_%' THEN 'prod'
        WHEN indexname LIKE 'idx_%' THEN 'NONE'
    END AS index_env
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
  AND indexname NOT LIKE '%_pkey'
ORDER BY tablename, indexname;

-- 4. Goose tracking tables (one per environment)
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE '%schema_migrations'
ORDER BY tablename;
