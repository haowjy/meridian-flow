package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"meridian/internal/config"
)

// Run wires and runs the backend server process.
func Run(cfg *config.Config) error {
	infra, err := NewInfrastructure(cfg)
	if err != nil {
		return fmt.Errorf("infrastructure: %w", err)
	}
	defer infra.Close()

	application, err := NewApplication(cfg, infra)
	if err != nil {
		infra.Logger.Error("application setup failed", "error", err)
		return fmt.Errorf("application setup: %w", err)
	}

	if err := application.Workers.Start(context.Background()); err != nil {
		infra.Logger.Error("worker startup failed", "error", err)
		return fmt.Errorf("worker startup: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = application.Workers.Stop(shutdownCtx)
	}()

	server := NewHTTPServer(cfg, application)
	infra.Logger.Info("server starting", "port", cfg.Server.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		infra.Logger.Error("server failed", "error", err)
		return fmt.Errorf("server failed: %w", err)
	}

	return nil
}
