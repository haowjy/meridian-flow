# Technical Documentation

Comprehensive technical specifications and implementation details for Meridian.

## Backend

Backend architecture, database, and API implementation.

### Backend Refactoring (October 2025)

**🚨 MUST READ for anyone working on backend architecture:**

- **[Architecture Review](./architecture-review.md)** ⭐ - Comprehensive analysis of current issues (Score: 4.25/10)
- **[Go Best Practices Research](./go-best-practices-research.md)** - 2025 Go patterns, recommended packages
- **[Refactoring Plan](./refactoring-plan.md)** - Step-by-step migration guide (2-3 weeks)

**Quick Summary:** Current backend needs refactoring to support LLM streaming and vector search. Migration to clean architecture (Handler → Service → Repository) with pgx, structured logging, and background jobs.

### Core Documentation

- **[Environment Setup](./backend/environment-setup.md)** - Environment-based table prefixes, deployment strategies
- **[Supabase Integration](./backend/supabase-integration.md)** - Database connection, API keys, connection methods
- **[API Testing](./backend/api-testing-comprehensive.md)** - Complete API testing guide with curl examples
- **[Database Seeding](./backend/database-seeding.md)** - Populate database with sample data

### Quick Links

For practical guides, see:
- `backend/README.md` - Main backend documentation
- `backend/QUICKSTART.md` - 5-minute setup guide
- `backend/tests/README.md` - Insomnia collection usage

## Frontend

*Coming in Phase 2*

## Deployment

*Coming in Phase 2*

---

## Documentation Philosophy

This directory contains **official technical documentation** that:
- Explains architectural decisions
- Provides comprehensive implementation details
- Serves as reference for complex topics
- Is tracked in the documentation system

For **practical guides** and **quick references**, see the respective project directories (`backend/`, `frontend/`, etc.).
