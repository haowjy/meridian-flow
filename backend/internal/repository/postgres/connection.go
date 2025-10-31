package postgres

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RepositoryConfig holds configuration for repository implementations
type RepositoryConfig struct {
	Pool   *pgxpool.Pool
	Tables *TableNames
	Logger *slog.Logger
}

// TableNames holds dynamically prefixed table names
type TableNames struct {
	Projects  string
	Folders   string
	Documents string
}

// NewTableNames creates table names with the given prefix
func NewTableNames(prefix string) *TableNames {
	return &TableNames{
		Projects:  fmt.Sprintf("%sprojects", prefix),
		Folders:   fmt.Sprintf("%sfolders", prefix),
		Documents: fmt.Sprintf("%sdocuments", prefix),
	}
}

// CreateConnectionPool creates a new pgx connection pool
func CreateConnectionPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse connection string: %w", err)
	}

	// Configure pool
	config.MaxConns = 25
	config.MinConns = 5

	// Disable automatic prepared statement caching to avoid conflicts
	// when using dynamic table names via fmt.Sprintf
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create connection pool: %w", err)
	}

	// Test connection
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return pool, nil
}
