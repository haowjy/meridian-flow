package domains

import (
	"log/slog"

	"meridian/internal/auth"
	"meridian/internal/repository/postgres"
)

// InfrastructureDeps carries shared infrastructure dependencies for module wiring.
type InfrastructureDeps struct {
	RepoConfig  *postgres.RepositoryConfig
	JWTVerifier auth.JWTVerifier
	Logger      *slog.Logger
}
