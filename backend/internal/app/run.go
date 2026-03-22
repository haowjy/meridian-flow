package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"meridian/internal/config"

	"golang.org/x/sync/errgroup"
)

// Run wires and runs the backend server process with structured lifecycle management.
func Run(cfg *config.Config, infra *Infrastructure, application *Application) error {
	if cfg == nil {
		return fmt.Errorf("config is nil")
	}
	if infra == nil {
		return fmt.Errorf("infrastructure is nil")
	}
	if application == nil {
		return fmt.Errorf("application is nil")
	}
	if application.Workers == nil {
		return fmt.Errorf("workers not configured")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	g, gctx := errgroup.WithContext(ctx)
	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	server := NewHTTPServer(cfg, application)

	g.Go(func() error {
		infra.Logger.Info("server starting", "port", cfg.Server.Port)

		err := server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("server failed: %w", err)
		}

		return nil
	})

	if err := application.Workers.Start(g, workerCtx); err != nil {
		stop()
		_ = server.Close()
		return fmt.Errorf("worker startup: %w", err)
	}

	g.Go(func() error {
		<-gctx.Done()
		infra.Logger.Info("shutdown signal received, draining HTTP")

		httpShutdownCtx, cancelHTTP := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelHTTP()

		if err := server.Shutdown(httpShutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http shutdown: %w", err)
		}

		infra.Logger.Info("HTTP drained, stopping workers")
		workerCancel()

		workerShutdownCtx, cancelWorkers := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelWorkers()

		if err := application.Workers.Stop(workerShutdownCtx); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				infra.Logger.Warn("workers stop deadline reached", "error", err)
				return nil
			}
			return fmt.Errorf("worker shutdown: %w", err)
		}

		return nil
	})

	if err := g.Wait(); err != nil {
		return err
	}

	return nil
}
