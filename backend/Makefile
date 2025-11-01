.PHONY: help build run test clean install dev

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

seed: ## Seed the database via API (recommended - uses scripts/seed.sh)
	./scripts/seed.sh

seed-fresh: ## Drop all tables and seed from scratch via API (recommended)
	./scripts/seed.sh --drop-tables

seed-clear: ## Clear all documents and folders (keep schema)
	go run ./cmd/seed/main.go --clear-data

seed-go: ## Seed the database using Go script (legacy - has JSONB encoding issues)
	go run ./cmd/seed/main.go

seed-schema: ## Drop and recreate tables only (no data seeding)
	go run ./cmd/seed/main.go --drop-tables --schema-only

