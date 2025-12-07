.PHONY: help build run test clean install dev llm-cli llm-cli-build build-local run-local migrate migrate-up migrate-down migrate-status migrate-dry-run migrate-sql migrate-prod migrate-staging

# Load environment variables from .env
include .env
export

# Derive TABLE_PREFIX from ENVIRONMENT (e.g., dev → dev_)
export TABLE_PREFIX := $(ENVIRONMENT)_

## Absolute path to workspace file for local builds
GO_WORK_FILE := $(abspath ../go.work)

# Goose binary location (adjust if needed)
GOOSE := $(shell which goose || echo ~/go/bin/goose)

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	go mod download
	go mod tidy

build: ## Build the server binary
	go build -o bin/server ./cmd/server

run: ## Run the server
	go run ./cmd/server/main.go

dev: ## Hot reload (air)
	air

test: ## Run tests
	go test -v ./...

clean: ## Clean build artifacts
	rm -rf bin/
	go clean

format: ## Format code
	go fmt ./...

lint: ## Run linter (requires golangci-lint)
	golangci-lint run

docker-build: ## Build Docker image
	docker build -t meridian-backend .

docker-run: ## Run Docker container
	docker run -p 8080:8080 --env-file .env meridian-backend

migrate: ## Interactive migration menu (goose mode for dev)
	@./scripts/migrate.sh

migrate-up: ## Apply pending migrations (goose mode)
	@./scripts/migrate.sh --yes up

migrate-down: ## Rollback last migration (goose mode)
	@./scripts/migrate.sh --yes down

migrate-status: ## Show migration status
	@./scripts/migrate.sh status

migrate-dry-run: ## Preview pending migrations (no changes)
	@./scripts/migrate.sh --dry-run

migrate-sql: ## Apply migrations via direct SQL (no goose tracking)
	@./scripts/migrate.sh --sql --yes up

migrate-prod: ## Apply migrations to production (SQL mode, requires .env.prod)
	@./scripts/migrate.sh --prod --yes up

migrate-staging: ## Apply migrations to staging (SQL mode, requires .env.staging)
	@./scripts/migrate.sh --staging --yes up

migrate-down-all: ## Rollback all migrations (drops all tables, goose only)
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" down-to 0

migrate-create: ## Create a new migration file (usage: make migrate-create name="add_feature")
	$(GOOSE) -dir migrations create $(name) sql

seed: ## Seed the database with data
	go run ./cmd/seed/main.go

seed-fresh: ## Drop all tables, run migrations, and seed data
	@echo "Dropping all tables..."
	@go run ./scripts/drop_all_tables.go
	@echo "Dropping goose version table (for fresh migration)..."
	@psql "$(SUPABASE_DB_URL)" -c "DROP TABLE IF EXISTS goose_db_version CASCADE;" 2>/dev/null || true
	@echo "Running migrations..."
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" up
	@echo "Seeding database..."
	go run ./cmd/seed/main.go

seed-clear: ## Clear all documents and folders (keep schema)
	go run ./cmd/seed/main.go --clear-data

seed-test: ## Seed test_ tables (uses .env.test, additive by default)
	@if [ ! -f .env.test ]; then \
		echo "❌ Error: .env.test not found"; \
		exit 1; \
	fi
	@echo "🌱 Seeding test_ tables (additive)..."
	@env -i PATH="$$PATH" HOME="$$HOME" go run ./cmd/seed/main.go --env-file=.env.test

seed-test-fresh: ## Clear and re-seed test_ tables (destructive)
	@if [ ! -f .env.test ]; then \
		echo "❌ Error: .env.test not found"; \
		exit 1; \
	fi
	@echo "🧹 Clearing and re-seeding test_ tables..."
	@env -i PATH="$$PATH" HOME="$$HOME" go run ./cmd/seed/main.go --env-file=.env.test --clear-data

run-cli: ## Run interactive LLM CLI (requires server running at localhost:8080)
	@echo "Starting interactive LLM CLI..."
	@echo "Controls: ↑/↓ navigate | ←/→ branches | [n]ew turn | [p]arams | [h]elp | [q]uit"
	@echo ""
	cd ../cli && go run .

build-cli: ## Build standalone LLM CLI binary
	cd ../cli && go build -o ../backend/bin/llm-cli .
	@echo "Built: bin/llm-cli"

# ===== Local workspace convenience targets =====

build-local: ## Build using local workspace (forces GOWORK=../go.work)
	GOWORK=$(GO_WORK_FILE) go build -o bin/server ./cmd/server

run-local: ## Run using local workspace (forces GOWORK=../go.work)
	GOWORK=$(GO_WORK_FILE) go run ./cmd/server/main.go
