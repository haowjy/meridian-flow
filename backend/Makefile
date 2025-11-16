.PHONY: help build run test clean install dev llm-cli llm-cli-build build-local run-local

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

migrate-up: ## Apply all pending migrations
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" up

migrate-down: ## Rollback last migration
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" down

migrate-down-all: ## Rollback all migrations (drops all tables)
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" down-to 0

migrate-status: ## Show migration status
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" status

migrate-create: ## Create a new migration file (usage: make migrate-create name="add_feature")
	$(GOOSE) -dir migrations create $(name) sql

seed: ## Seed the database with data (runs migrations first)
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" up
	go run ./cmd/seed/main.go

seed-fresh: ## Drop all tables, run migrations, and seed data
	@echo "Dropping all tables..."
	@go run ./scripts/drop_all_tables.go
	@echo "Running migrations..."
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" up
	@echo "Seeding database..."
	go run ./cmd/seed/main.go

seed-clear: ## Clear all documents and folders (keep schema)
	go run ./cmd/seed/main.go --clear-data

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
