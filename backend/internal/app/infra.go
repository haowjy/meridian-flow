package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"

	"meridian/internal/auth"
	"meridian/internal/config"
	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Infrastructure owns shared process-level resources.
type Infrastructure struct {
	Pool        *pgxpool.Pool
	Tables      *postgres.TableNames
	RepoConfig  *postgres.RepositoryConfig
	JWTVerifier auth.JWTVerifier
	Logger      *slog.Logger
	logFile     io.Closer
}

// NewInfrastructure builds logging, auth, and database resources.
func NewInfrastructure(cfg *config.Config) (*Infrastructure, error) {
	logLevel := config.ParseLogLevel(cfg.Logging.Level)

	var logOutput io.Writer = os.Stdout
	var logFile io.Closer
	if cfg.Logging.ToFile {
		f, err := config.SetupLogFile(cfg.Logging.Dir, cfg.Logging.MaxFiles)
		if err != nil {
			return nil, fmt.Errorf("setup log file: %w", err)
		}
		logOutput = io.MultiWriter(os.Stdout, f)
		logFile = f
	}

	logger := slog.New(slog.NewJSONHandler(logOutput, &slog.HandlerOptions{
		Level: logLevel,
	}))
	slog.SetDefault(logger)

	logger.Info("server starting",
		"environment", cfg.Server.Environment,
		"port", cfg.Server.Port,
		"table_prefix", cfg.Database.TablePrefix,
		"log_level", cfg.Logging.Level,
		"log_to_file", cfg.Logging.ToFile,
	)

	jwtVerifier, err := auth.NewJWTVerifier(cfg.Auth.SupabaseJWKSURL, logger)
	if err != nil {
		return nil, fmt.Errorf("create jwt verifier: %w", err)
	}

	pool, err := postgres.CreateConnectionPool(context.Background(), cfg.Database.URL, cfg.Database.MaxConns, cfg.Database.MinConns)
	if err != nil {
		_ = jwtVerifier.Close()
		return nil, fmt.Errorf("create connection pool: %w", err)
	}

	logger.Info("database connected",
		"max_conns", cfg.Database.MaxConns,
		"min_conns", cfg.Database.MinConns,
	)

	tables := postgres.NewTableNames(cfg.Database.TablePrefix)
	repoConfig := &postgres.RepositoryConfig{
		Pool:   pool,
		Tables: tables,
		Logger: logger,
	}

	return &Infrastructure{
		Pool:        pool,
		Tables:      tables,
		RepoConfig:  repoConfig,
		JWTVerifier: jwtVerifier,
		Logger:      logger,
		logFile:     logFile,
	}, nil
}

// Close tears down shared infrastructure resources.
func (i *Infrastructure) Close() {
	if i == nil {
		return
	}
	if i.Pool != nil {
		i.Pool.Close()
	}
	if i.JWTVerifier != nil {
		_ = i.JWTVerifier.Close()
	}
	if i.logFile != nil {
		_ = i.logFile.Close()
	}
}
