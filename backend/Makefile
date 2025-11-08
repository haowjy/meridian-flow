.PHONY: help build run test clean install dev

# Load environment variables from .env
include .env
export

# Derive TABLE_PREFIX from ENVIRONMENT (e.g., dev → dev_)
export TABLE_PREFIX := $(ENVIRONMENT)_

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

dev: ## Run the server with hot reload (requires air)
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
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" down-to 0
	$(GOOSE) -dir migrations postgres "$(SUPABASE_DB_URL)" up
	go run ./cmd/seed/main.go

seed-clear: ## Clear all documents and folders (keep schema)
	go run ./cmd/seed/main.go --clear-data

