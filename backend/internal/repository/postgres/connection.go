package postgres

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/domain/repositories"
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

	// Thread system tables
	Threads            string
	Turns              string
	TurnBlocks         string
	AssistantResponses string

	// User preferences
	UserPreferences string

	// User project favorites (junction table)
	UserProjectFavorites string

	// Skills system tables
	ProjectSkills string

	// Collaboration tables
	CollabDocumentSnapshots   string
	CollabDocumentUpdates     string
	CollabDocumentCheckpoints string
	CollabDocumentBookmarks   string
	CollabDocumentProposals   string
	CollabRequestIdempotency  string
	TurnDocumentTouches       string
}

// NewTableNames creates table names with the given prefix
func NewTableNames(prefix string) *TableNames {
	return &TableNames{
		Projects:  fmt.Sprintf("%sprojects", prefix),
		Folders:   fmt.Sprintf("%sfolders", prefix),
		Documents: fmt.Sprintf("%sdocuments", prefix),

		// Thread system tables
		Threads:            fmt.Sprintf("%sthreads", prefix),
		Turns:              fmt.Sprintf("%sturns", prefix),
		TurnBlocks:         fmt.Sprintf("%sturn_blocks", prefix),
		AssistantResponses: fmt.Sprintf("%sassistant_responses", prefix),

		// User preferences
		UserPreferences: fmt.Sprintf("%suser_preferences", prefix),

		// User project favorites (junction table)
		UserProjectFavorites: fmt.Sprintf("%suser_project_favorites", prefix),

		// Skills system tables
		ProjectSkills: fmt.Sprintf("%sproject_skills", prefix),

		// Collaboration tables
		CollabDocumentSnapshots:   fmt.Sprintf("%scollab_document_snapshots", prefix),
		CollabDocumentUpdates:     fmt.Sprintf("%scollab_document_updates", prefix),
		CollabDocumentCheckpoints: fmt.Sprintf("%scollab_document_checkpoints", prefix),
		CollabDocumentBookmarks:   fmt.Sprintf("%scollab_document_bookmarks", prefix),
		CollabDocumentProposals:   fmt.Sprintf("%scollab_document_edit_proposals", prefix),
		CollabRequestIdempotency:  fmt.Sprintf("%scollab_request_idempotency", prefix),
		TurnDocumentTouches:       fmt.Sprintf("%sturn_document_touches", prefix),
	}
}

// CreateConnectionPool creates a new pgx connection pool with automatic PgBouncer compatibility.
//
// Query Execution Mode Configuration:
//
// By default, pgx uses prepared statements (QueryExecModeCacheStatement) which provide:
// - Better performance through statement caching
// - Proper JSONB encoding/decoding
// - Protection against SQL injection
//
// However, PgBouncer in transaction pooling mode (port 6543 on Supabase) does NOT support
// prepared statements, causing "prepared statement already exists" errors.
//
// Solution - Hybrid Approach:
//
//  1. AUTO-DETECTION: If port 6543 is detected (Supabase pooler), automatically uses
//     QueryExecModeSimpleProtocol which disables prepared statements.
//
//  2. EXPLICIT OVERRIDE: Users can set the mode via connection string parameter:
//     ?default_query_exec_mode=simple_protocol
//     This is parsed by pgx automatically and takes precedence over auto-detection.
//
//  3. DIRECT CONNECTIONS: Port 5432 (direct PostgreSQL) uses default prepared statements
//     for optimal performance.
//
// Note on Dynamic Table Names:
// Our use of fmt.Sprintf for dynamic table prefixes (dev_, test_, prod_) is safe with
// prepared statements because the SQL string is interpolated BEFORE being sent to the
// database. Each environment gets its own prepared statements (e.g., "SELECT FROM dev_documents"
// vs "SELECT FROM prod_documents" are separate statements).
//
// References:
// - Supabase connection docs: https://supabase.com/docs/guides/database/connecting-to-postgres
// - pgx QueryExecMode: https://pkg.go.dev/github.com/jackc/pgx/v5#QueryExecMode
func CreateConnectionPool(ctx context.Context, databaseURL string, maxConns, minConns int) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse connection string: %w", err)
	}

	// Configure pool size
	// If unset/misconfigured, fall back to previous defaults.
	if maxConns < 1 {
		maxConns = 25
	}
	if minConns < 0 {
		minConns = 5
	}
	if minConns > maxConns {
		minConns = maxConns
	}

	config.MaxConns = int32(maxConns)
	config.MinConns = int32(minConns)

	// Auto-detect PgBouncer (port 6543) and configure appropriate query execution mode
	// Port 6543 is Supabase's transaction pooler which doesn't support prepared statements
	//
	// QueryExecModeCacheDescribe is used because it:
	// - Uses extended protocol (required for proper JSONB encoding of map[string]interface{})
	// - Caches statement descriptions (not prepared statements) - PgBouncer compatible
	// - Avoids "prepared statement already exists" errors
	// - Avoids "cannot encode map[string]interface{}" errors
	//
	// Alternative modes and their issues:
	// - CacheStatement: Creates prepared statements (breaks PgBouncer)
	// - SimpleProtocol: Can't encode map[string]interface{} to JSONB (no type info)
	// - DescribeExec: Works but slower (describes on every execution)
	//
	// If user explicitly set default_query_exec_mode in connection string, that takes precedence
	if config.ConnConfig.Port == 6543 && config.ConnConfig.DefaultQueryExecMode == pgx.QueryExecModeCacheStatement {
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe
		slog.Debug("auto-configured cache_describe mode for PgBouncer compatibility", "port", 6543)
	}

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

// GetExecutor returns the appropriate query executor for the context.
// If a transaction is present in the context, it returns the transaction.
// Otherwise, it returns the provided pool.
// This enables repositories to automatically participate in transactions when they exist.
func GetExecutor(ctx context.Context, pool *pgxpool.Pool) repositories.DBTX {
	// Check if there's a transaction in the context
	if tx := repositories.GetTx(ctx); tx != nil {
		return tx
	}
	// No transaction, use the pool
	return pool
}
