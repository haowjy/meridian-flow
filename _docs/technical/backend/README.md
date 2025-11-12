---
detail: minimal
audience: developer
---

# Backend Technical Documentation

Complete technical reference for the Meridian backend (Go + Fiber + PostgreSQL).

## Quick Links

**First time?** → [Getting Started](#getting-started)
**API Reference?** → [API Contracts](api/contracts.md)
**Architecture?** → [Architecture Overview](architecture/overview.md)
**Database?** → [Schema](database/schema.md)
**Troubleshooting?** → [Debugging Guide](development/debugging.md)

## Getting Started

### Quick Start (5 minutes)
See `/backend/CLAUDE.md` for commands and setup workflow.

### Setup Resources
- [Database Connections](database/connections.md) - PgBouncer vs direct connections
- [Database Schema](database/schema.md) - Complete schema with ER diagrams
- [API Overview](api/overview.md) - Available endpoints

## Architecture

Clean Architecture (Hexagonal) with clear layer separation:

- [Overview](architecture/overview.md) - Architecture, design principles, and layer responsibilities

## API

Complete API reference with contracts, validation rules, and examples:

- [Overview](api/overview.md) - API design and navigation
- [Contracts](api/contracts.md) - All endpoints with request/response formats ⭐
- [Error Responses](api/error-responses.md) - RFC 7807 error format and conflict resolution

## Database

PostgreSQL schema, connections, and data management:

- [Schema](database/schema.md) - Database structure with ER diagram ⭐
- [Connections](database/connections.md) - Connection setup and troubleshooting

## Chat System

**Status:** ✅ Core features complete, streaming in development

Multi-turn LLM conversations with SOLID-compliant service architecture:

- Domain model: [chat/overview.md](chat/overview.md)
- Service layer: [architecture/service-layer.md](architecture/service-layer.md)
- Pagination: [chat/pagination.md](chat/pagination.md)
- LLM providers: [chat/llm-providers.md](chat/llm-providers.md)
- Turn blocks: [chat/turn-blocks.md](chat/turn-blocks.md)
- Schema: [database/schema.md](database/schema.md#chat-system)
- Testing: 29 Insomnia test requests

## Streaming System

**Status:** 🚧 In Development

Real-time LLM response delivery via Server-Sent Events:

- Overview: [streaming/README.md](streaming/README.md)
- Architecture: [architecture/streaming-architecture.md](architecture/streaming-architecture.md)
- API endpoints: [streaming/api-endpoints.md](streaming/api-endpoints.md)
- Tool execution: [streaming/tool-execution.md](streaming/tool-execution.md)
- Edge cases: [streaming/edge-cases.md](streaming/edge-cases.md)

## Development

Tools and workflows for development:

- [Debugging](development/debugging.md) - Common issues and solutions
- [Workspace + Submodule](development/workspace-and-submodule.md) - Local edits with pinned deps
- Test data: Run `make seed-fresh` (see `/backend/CLAUDE.md`)

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
