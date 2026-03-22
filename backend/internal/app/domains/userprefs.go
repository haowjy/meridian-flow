package domains

import (
	"net/http"

	"meridian/internal/config"
	"meridian/internal/domain"
	"meridian/internal/handler"
	"meridian/internal/repository/postgres"
	"meridian/internal/service"
)

// UserPrefsModule wires user preferences service and handler.
type UserPrefsModule struct {
	Service domain.UserPreferencesService
	Handler *handler.UserPreferencesHandler
}

// NewUserPrefsModule creates user preferences service and handler.
func NewUserPrefsModule(infra InfrastructureDeps, cfg *config.Config) (*UserPrefsModule, error) {
	userPrefsRepo := postgres.NewUserPreferencesRepository(infra.RepoConfig)
	userPrefsService := service.NewUserPreferencesService(userPrefsRepo, infra.Logger)

	return &UserPrefsModule{
		Service: userPrefsService,
		Handler: handler.NewUserPreferencesHandler(userPrefsService, infra.Logger, cfg),
	}, nil
}

// RegisterRoutes registers user preference routes.
func (m *UserPrefsModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/users/me/preferences", m.Handler.GetPreferences)
	mux.HandleFunc("PATCH /api/users/me/preferences", m.Handler.UpdatePreferences)
}
