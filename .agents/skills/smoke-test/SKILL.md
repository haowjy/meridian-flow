---
name: smoke-test
description: Conventions for ad-hoc smoke tests and curl probes. Configurable via SMOKE_TEST_ROOT env var.
user-invocable: false
---

# Smoke Test Conventions

Smoke tests are disposable scripts used to verify API endpoints and integrations.

**`SMOKE_TEST_ROOT`** — env var that sets the root. Default: `.data/` within this skill directory (i.e., `.agents/skills/smoke-test/.data/`).

Other skills (e.g., orchestrate) may override this with their own scope roots.

## Rules

- Treat smoke tests as scratch code artifacts — never commit them
- Store one-off curl scripts and ad-hoc probes in `$SMOKE_TEST_ROOT`
- Do not store secrets or raw tokens in smoke files (`.env` values, JWTs, API keys, cookies)
- Check project instruction files (`CLAUDE.md` or `AGENTS.md`) for auth token scripts and API base URL
- Use any project-provided token/auth helpers for authenticated requests
