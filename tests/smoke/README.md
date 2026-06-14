# Smoke test harness

Lightweight HTTP servers and playbooks for verifying runtime behavior without
the full authenticated app stack.

## Quick start

```bash
# Self-test: start server, hit /health + /generate, exit
pnpm exec tsx tests/smoke/run.ts

# Keep the server running for manual curls or agent-driven scenarios
pnpm exec tsx tests/smoke/server.ts
```

The server prints its base URL and registered providers on startup. Use that URL
as `$BASE` in guides, or set `PORT` before starting to bind a fixed port.

## Layout

| Path | Purpose |
|------|---------|
| `server.ts` | Mini HTTP server exposing the model gateway over HTTP |
| `run.ts` | CLI runner — starts server, runs a quick self-test, exits |
| `load-env.ts` | Loads repo-root `.env` without logging secrets |
| `guides/` | Markdown playbooks for manual/agent-run smoke checks |

Full wired-stack flows still use the portless dev stack and the app/server smoke
scripts under `apps/*`.
