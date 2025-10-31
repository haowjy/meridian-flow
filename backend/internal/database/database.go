package database

import (
	"database/sql"
	"fmt"
	"log"

	_ "github.com/lib/pq"
)

type DB struct {
	*sql.DB
	Tables *TableNames
}

func Connect(dbURL string, tablePrefix string) (*DB, error) {
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Test the connection
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	log.Printf("Successfully connected to database (table prefix: %s)", tablePrefix)

	return &DB{
		DB:     db,
		Tables: NewTableNames(tablePrefix),
	}, nil
}

func (db *DB) Close() error {
	return db.DB.Close()
}

