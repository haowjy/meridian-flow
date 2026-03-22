package main

import (
	"os"

	"meridian/internal/app"
	"meridian/internal/config"

	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	infra, err := app.NewInfrastructure(cfg)
	if err != nil {
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
	defer infra.Close()

	application, err := app.NewApplication(cfg, infra)
	if err != nil {
		infra.Logger.Error("application setup failed", "error", err)
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}

	if err := app.Run(cfg, infra, application); err != nil {
		infra.Logger.Error("application error", "error", err)
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}
