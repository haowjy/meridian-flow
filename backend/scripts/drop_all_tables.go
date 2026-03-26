package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	dbURL := os.Getenv("SUPABASE_DB_URL")
	if dbURL == "" {
		log.Fatal("SUPABASE_DB_URL environment variable is required")
	}

	// Read environment to determine table prefix
	env := os.Getenv("ENVIRONMENT")
	if env == "" {
		env = "dev" // Default to dev
	}

	var prefix string
	if env == "prod" {
		prefix = ""
	} else {
		prefix = env + "_"
	}

	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer func() { _ = db.Close() }() // Error ignored: script exiting

	// Dynamically discover and drop all tables matching the prefix
	tables, err := discoverTables(db, prefix)
	if err != nil {
		log.Fatalf("Failed to discover tables: %v", err)
	}

	for _, table := range tables {
		dropSQL := fmt.Sprintf("DROP TABLE IF EXISTS %s CASCADE", table)
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
		dropSQL := fmt.Sprintf("DROP FUNCTION IF EXISTS %s CASCADE", fn)
		if _, err := db.Exec(dropSQL); err != nil {
			log.Fatalf("Failed to drop function %s: %v", fn, err)
		}
		fmt.Printf("Dropped function: %s\n", fn)
	}

	// Drop goose migration tracking table
	if _, err := db.Exec("DROP TABLE IF EXISTS goose_db_version CASCADE"); err != nil {
		log.Fatalf("Failed to drop goose_db_version: %v", err)
	}
	fmt.Printf("Dropped table: goose_db_version\n")

	fmt.Printf("\nAll tables and functions dropped successfully (prefix: %s)\n", prefix)
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
