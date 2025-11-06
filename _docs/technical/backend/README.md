---
detail: minimal
audience: developer
---

# Backend Technical Documentation

Complete technical reference for the Meridian backend (Go + Fiber + PostgreSQL).

## Quick Links

**First time?** → [Getting Started](#getting-started)
**API Reference?** → [API Contracts](api-contracts.md)
**Architecture?** → [Architecture Overview](architecture/overview.md)
**Troubleshooting?** → [Debugging Guide](development/debugging.md)

## Getting Started

### Quick Start (5 minutes)
See `/backend/QUICKSTART.md` for fastest path to running server.

### Detailed Setup
For comprehensive setup including Supabase configuration, database setup, and environment details:
- [Detailed Setup Guide](getting-started/detailed-setup.md) - Complete first-time setup
- [Database Connections](database/connections.md) - PgBouncer vs direct connections
- [First Document Tutorial](getting-started/first-document-tutorial.md) - Hands-on API walkthrough

## Architecture

Clean Architecture (Hexagonal) with clear layer separation:

- [Overview](architecture/overview.md) - High-level architecture and design principles
- [Layers](architecture/layers.md) - Handler → Service → Repository explained
- [Request Lifecycle](architecture/request-lifecycle.md) - How requests flow through the system
- [Go Patterns](architecture/go-patterns.md) - Common Go patterns used in the codebase

## API

Complete API reference with contracts, validation rules, and examples:

- [Overview](api/overview.md) - API design and navigation
- [Contracts](api-contracts.md) - All endpoints with request/response formats ⭐
- [Error Handling](api/error-handling.md) - Error responses and conflict resolution

## Database

PostgreSQL schema, connections, and data management:

- [Schema](database/schema.md) - Database structure with ER diagram
- [Connections](database/connections.md) - Connection setup and troubleshooting
- [Seeding](database/seeding.md) - Test data and seed scripts

## Development

Tools and workflows for development:

- [Testing](development/testing.md) - Unit tests, API tests, Insomnia collection
- [Debugging](development/debugging.md) - Common issues and solutions
- [Deployment](development/deployment.md) - Railway deployment and environments

## Documentation Conventions

All backend docs follow these standards:

**Frontmatter:**
```yaml
---
detail: minimal | standard | comprehensive
audience: developer | architect | claude
---
```

**Reference format:** `file_path:line_number` (e.g., `internal/handler/document.go:45`)

**Diagrams:** Dark-mode compatible Mermaid diagrams where helpful

## Quick Reference

**Commands:** See `/backend/CLAUDE.md`
**Environment:** See `/backend/.ENVIRONMENTS.md`
**Project root:** See `/CLAUDE.md`
