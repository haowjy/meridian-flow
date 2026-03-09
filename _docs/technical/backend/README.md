---
detail: minimal
audience: developer
---

# Backend Technical Documentation

Complete technical reference for the Meridian backend (Go + net/http + PostgreSQL).

## Quick Links

**First time?** -> [Getting Started](#getting-started)
**API Reference?** -> [API Contracts](api/contracts.md)
**Architecture?** -> [Architecture Overview](architecture/overview.md)
**Database?** -> [Schema](database/schema.md)
**Troubleshooting?** -> [Debugging Guide](development/debugging.md)

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

- [Overview](api/overview.md) - Endpoint groups, auth pattern, key behaviors
- [Contracts](api/contracts.md) - Route table with handler files ⭐
- [Error Responses](api/error-responses.md) - RFC 7807 error format

## Database

- [Schema](database/schema.md) - ER diagram, table purposes, FK cascades ⭐
- [Connections](database/connections.md) - PgBouncer auto-config and pool settings

## Document Search

- [Search Architecture](search-architecture.md) - PostgreSQL FTS with snippets, ranking, and pagination

## LLM Integration

**Library:** [`meridian-llm-go`](../llm/README.md) - Unified provider abstraction

The backend uses the `meridian-llm-go` library for all LLM provider interactions.

**For LLM library documentation:**
- [Architecture](../llm/architecture.md) - Library design and 3-layer architecture
- [Streaming](../llm/streaming/README.md) - Streaming architecture and block types

**For backend integration:**
- [Provider Routing](provider-routing.md) - Model string parsing and provider selection
- [Tools Architecture](tools/architecture.md) - Tool registry, builder, and execution
- [Service Layer](architecture/service-layer.md) - ThreadHistoryService, StreamingService

## Repository Patterns

**Conditional updates with pointer semantics**: Use `nil` pointer to mean "skip update", non-nil to mean "update to this value". Combined with `COALESCE` in SQL for atomic partial updates. See `internal/repository/postgres/llm/turn.go:AccumulateTokensAndUpdateMetadata()` and domain types in `internal/domain/repositories/llm/turn_writer.go`.

## Authentication

**Status:** Backend ✅ Complete | Frontend ✅ Complete

- [Cross-Stack Overview](../auth-overview.md) - Complete auth flow from frontend to backend ⭐
- [Authorization](auth/authorization.md) - Service-layer ownership-based authorization
- [Frontend Auth](../frontend/auth-implementation.md) - Frontend Supabase integration

## Thread System

**Status:** ✅ Complete (multi-turn, streaming, catchup working)

Multi-turn LLM conversations with SOLID-compliant service architecture:

- Domain model: [thread/overview.md](thread/overview.md)
- Service layer: [architecture/service-layer.md](architecture/service-layer.md)
- Pagination: [thread/pagination.md](thread/pagination.md)
- LLM providers: [thread/llm-providers.md](thread/llm-providers.md)
- Turn blocks: [thread/turn-blocks.md](thread/turn-blocks.md)
- Schema: [database/schema.md](database/schema.md#thread-system)

## Streaming System

**Status:** ✅ Working (catchup, multi-block, race conditions fixed)

Real-time LLM response delivery via Server-Sent Events:

- **Start here:** [../llm/streaming/README.md](../llm/streaming/README.md) ⭐
- Architecture: [architecture/service-layer.md](architecture/service-layer.md)
- Block types: [thread/turn-blocks.md](thread/turn-blocks.md)
- API endpoints: [../llm/streaming/api-endpoints.md](../llm/streaming/api-endpoints.md)
- Race conditions: [../llm/streaming/race-conditions.md](../llm/streaming/race-conditions.md)
- Tool execution: [../llm/streaming/tool-execution.md](../llm/streaming/tool-execution.md)
- Edge cases: [../llm/streaming/edge-cases.md](../llm/streaming/edge-cases.md)

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
