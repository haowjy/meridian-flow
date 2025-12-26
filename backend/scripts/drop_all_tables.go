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

	// Drop all tables with environment-specific prefix
	dropSQL := fmt.Sprintf(`
		DROP TABLE IF EXISTS %sturn_blocks CASCADE;
		DROP TABLE IF EXISTS %sturns CASCADE;
		DROP TABLE IF EXISTS %schats CASCADE;
		DROP TABLE IF EXISTS %sdocuments CASCADE;
		DROP TABLE IF EXISTS %sfolders CASCADE;
		DROP TABLE IF EXISTS %sprojects CASCADE;
		DROP TABLE IF EXISTS goose_db_version CASCADE;
	`, prefix, prefix, prefix, prefix, prefix, prefix)

	if _, err := db.Exec(dropSQL); err != nil {
		log.Fatalf("Failed to drop tables: %v", err)
	}

	fmt.Printf("All tables dropped successfully (prefix: %s)\n", prefix)
}
