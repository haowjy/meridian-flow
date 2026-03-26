package app

import (
	"net/http"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/middleware"

	"github.com/rs/cors"
)

// NewHTTPServer creates the HTTP server with all routes and middleware.
func NewHTTPServer(cfg *config.Config, app *Application) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", app.Docsystem.DocumentHandler.HealthCheck)

	app.Docsystem.RegisterRoutes(mux)
	app.Skill.RegisterRoutes(mux)
	app.Collab.RegisterRoutes(mux)
	app.UserPrefs.RegisterRoutes(mux)
	app.Auth.RegisterRoutes(mux)
	app.Billing.RegisterRoutes(mux)
	app.WorkItem.RegisterRoutes(mux)
	app.LLM.RegisterRoutes(mux, app.Billing.AdmissionChecker)
	mux.HandleFunc("GET /api/models/capabilities", app.LLM.ModelsHandler.GetCapabilities)

	if cfg.Server.Environment == "dev" && app.LLM.DebugHandler != nil {
		app.LLM.RegisterDebugRoutes(mux, cfg)
		app.Infra.Logger.Debug("debug endpoints registered",
			"count", 3,
			"routes", []string{
				"POST /debug/api/threads/:id/turns",
				"GET /debug/api/threads/:id/tree",
				"POST /debug/api/threads/:id/llm-request",
			},
		)
	}

	var httpHandler http.Handler = mux
	httpHandler = middleware.AuthMiddleware(app.Infra.JWTVerifier, cfg.IsProdIdentityBlocked)(httpHandler)
	httpHandler = middleware.Recovery(app.Infra.Logger)(httpHandler)
	httpHandler = newCORSHandler(cfg).Handler(httpHandler)

	return &http.Server{
		Addr:         ":" + cfg.Server.Port,
		Handler:      httpHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  60 * time.Second,
	}
}

func newCORSHandler(cfg *config.Config) *cors.Cors {
	return cors.New(cors.Options{
		AllowedOrigins:   strings.Split(cfg.Server.CORSOrigins, ","),
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Origin", "Content-Type", "Accept", "Authorization", "Last-Event-ID"},
		AllowCredentials: true,
	})
}
