package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	dbURL := os.Getenv("SUPABASE_DB_URL")
	if dbURL == "" {
		log.Fatal("SUPABASE_DB_URL environment variable is required")
	}
	dbURL = ensureSimpleProtocol(dbURL)

	// Read environment to determine table prefix
	env := os.Getenv("ENVIRONMENT")
	if env == "" {
		env = "dev" // Default to dev
	}

	// Production safety guard: prevent accidental destruction of prod tables.
	// When env="prod", prefix would be "", matching ALL tables via LIKE '%'.
	if env == "prod" {
		log.Fatal("BLOCKED: Cannot drop tables in production environment. " +
			"Use Supabase dashboard for production schema changes.")
	}

	prefix := env + "_"

	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer func() { _ = db.Close() }() // Error ignored: script exiting

	// Dynamically discover and drop all indexes matching the prefix
	// (before tables, to catch orphaned or conflicting indexes)
	indexes, err := discoverIndexes(db, prefix)
	if err != nil {
		log.Fatalf("Failed to discover indexes: %v", err)
	}

	for _, idx := range indexes {
		dropSQL := fmt.Sprintf("DROP INDEX IF EXISTS %s", quoteIdent(idx))
		if _, err := db.Exec(dropSQL); err != nil {
			log.Fatalf("Failed to drop index %s: %v", idx, err)
		}
		fmt.Printf("Dropped index: %s\n", idx)
	}

	// Dynamically discover and drop all tables matching the prefix
	tables, err := discoverTables(db, prefix)
	if err != nil {
		log.Fatalf("Failed to discover tables: %v", err)
	}

	for _, table := range tables {
		dropSQL := fmt.Sprintf("DROP TABLE IF EXISTS %s CASCADE", quoteIdent(table))
		if _, err := db.Exec(dropSQL); err != nil {
			log.Fatalf("Failed to drop table %s: %v", table, err)
		}
		fmt.Printf("Dropped table: %s\n", table)
	}

	// Dynamically discover and drop all functions matching the prefix
	functions, err := discoverFunctions(db, prefix)
	if err != nil {
		log.Fatalf("Failed to discover functions: %v", err)
	}

	for _, fn := range functions {
		dropSQL := fmt.Sprintf("DROP FUNCTION IF EXISTS %s CASCADE", quoteIdent(fn))
		if _, err := db.Exec(dropSQL); err != nil {
			log.Fatalf("Failed to drop function %s: %v", fn, err)
		}
		fmt.Printf("Dropped function: %s\n", fn)
	}

	// Drop env-scoped migration tracking table (used by scripts/migrate.sh).
	// Do not drop global goose_db_version here; that may be shared across environments.
	migrationTable := prefix + "schema_migrations"
	if _, err := db.Exec(fmt.Sprintf("DROP TABLE IF EXISTS %s CASCADE", quoteIdent(migrationTable))); err != nil {
		log.Fatalf("Failed to drop table %s: %v", migrationTable, err)
	}
	fmt.Printf("Dropped table: %s\n", migrationTable)

	fmt.Printf("\nAll indexes, tables, functions, and env migration tracking dropped successfully (prefix: %s)\n", prefix)
}

// discoverTables queries pg_tables for all tables matching the given prefix in the public schema.
func discoverTables(db *sql.DB, prefix string) ([]string, error) {
	query := "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1"
	rows, err := db.Query(query, prefix+"%")
	if err != nil {
		return nil, fmt.Errorf("querying pg_tables: %w", err)
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scanning table name: %w", err)
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

// discoverIndexes queries pg_indexes for all custom indexes belonging to this environment.
// Matches indexes on prefixed tables OR indexes named with the prefix (catches orphans).
// Includes only app-managed idx_* indexes, excluding constraint-owned indexes.
func discoverIndexes(db *sql.DB, prefix string) ([]string, error) {
	query := `SELECT DISTINCT indexname FROM pg_indexes
		WHERE schemaname = 'public'
		AND (tablename LIKE $1 OR indexname LIKE $2)
		AND indexname LIKE 'idx_%'`
	rows, err := db.Query(query, prefix+"%", "idx_"+prefix+"%")
	if err != nil {
		return nil, fmt.Errorf("querying pg_indexes: %w", err)
	}
	defer rows.Close()

	var indexes []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scanning index name: %w", err)
		}
		indexes = append(indexes, name)
	}
	return indexes, rows.Err()
}

// discoverFunctions queries information_schema.routines for all functions matching the given prefix.
func discoverFunctions(db *sql.DB, prefix string) ([]string, error) {
	query := "SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name LIKE $1"
	rows, err := db.Query(query, prefix+"%")
	if err != nil {
		return nil, fmt.Errorf("querying routines: %w", err)
	}
	defer rows.Close()

	var functions []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scanning function name: %w", err)
		}
		functions = append(functions, name)
	}
	return functions, rows.Err()
}

// quoteIdent safely quotes a SQL identifier (table/index/function name).
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// ensureSimpleProtocol appends pgx simple-protocol mode to avoid PgBouncer
// prepared-statement conflicts (common on Supabase pooler port 6543).
func ensureSimpleProtocol(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		// Fall back to raw URL; connection attempt will report a clear error.
		return raw
	}

	q := u.Query()
	if q.Get("default_query_exec_mode") == "" {
		q.Set("default_query_exec_mode", "simple_protocol")
		u.RawQuery = q.Encode()
	}
	return u.String()
}
