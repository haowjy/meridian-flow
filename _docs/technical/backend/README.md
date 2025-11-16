---
detail: minimal
audience: developer
---

# Backend Technical Documentation

Complete technical reference for the Meridian backend (Go + net/http + PostgreSQL).

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

## LLM Integration

**Library:** [`meridian-llm-go`](../llm/README.md) - Unified provider abstraction

The backend uses the `meridian-llm-go` library for all LLM provider interactions.

**For LLM library documentation:**
- [Architecture](../llm/architecture.md) - Library design and 3-layer architecture
- [Tool Mapping](../llm/unified-tool-mapping.md) - Unified tool abstraction across providers
- [Error Handling](../llm/error-normalization.md) - Error normalization and retry strategies
- [Capability Loading](../llm/capability-loading.md) - Provider config loading patterns
- [Streaming](../llm/streaming/README.md) - Streaming architecture and block types

**For backend integration:**
- [LLM Integration Guide](./llm-integration.md) - How backend uses meridian-llm-go
- [Provider Routing](provider-routing.md) - Model string parsing and provider selection
- [Environment Gating](environment-gating.md) - Tool restrictions (dev/test only)

## Chat System

**Status:** ✅ Complete (multi-turn, streaming, catchup working)

Multi-turn LLM conversations with SOLID-compliant service architecture:

- Domain model: [chat/overview.md](chat/overview.md)
- Service layer: [architecture/service-layer.md](architecture/service-layer.md)
- Pagination: [chat/pagination.md](chat/pagination.md)
- LLM providers: [chat/llm-providers.md](chat/llm-providers.md)
- Turn blocks: [chat/turn-blocks.md](chat/turn-blocks.md)
- Schema: [database/schema.md](database/schema.md#chat-system)
- Testing: 29 Insomnia test requests

## Streaming System

**Status:** ✅ Working (catchup, multi-block, race conditions fixed)

Real-time LLM response delivery via Server-Sent Events:

- **Start here:** [../llm/streaming/README.md](../llm/streaming/README.md) ⭐
- Architecture: [architecture/streaming-architecture.md](architecture/streaming-architecture.md)
- Block types: [../llm/streaming/block-types-reference.md](../llm/streaming/block-types-reference.md)
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
