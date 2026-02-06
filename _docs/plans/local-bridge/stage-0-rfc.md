---
detail: comprehensive
audience: developer
---

# Stage 0: RFC + Threat Model (Design-Only)

Goal: Make the major decisions explicit (API shape, security posture, rollout), then get sign-off before implementation.

## Decisions To Lock

- `Local Bridge language/runtime`: Go (fits repo) vs Rust/Node.
- `Transport`: loopback HTTP + SSE streaming (debuggable, works with browser).
- `Mount semantics`: `projectId` -> one or more local directories.
- `Path canonicalization`: Meridian uses `/` separators; bridge maps to OS paths.
- `Sync responsibility`: bridge handles watch/read/write; backend remains canonical for IDs/tree/metadata.

## Non-Goals (v1)

- No always-on background sync when browser is closed (desktop app later).
- No cross-device sync via bridge (backend remains remote source for multi-device).
- No automatic conflict merges (explicit user choice first).

## Security Posture (Baseline)

Default deny:
- Bridge binds to `127.0.0.1` only.
- Pairing required before any privileged endpoint works.
- Tokens are short-lived and scoped to:
  - exact allowed `Origin`
  - specific `projectId` + mounts
  - permission scopes: `fs.read`, `fs.write`, `exec`, `llm`
- CORS allowlist is strict (exact origins, no wildcard).
- Requests without `Origin` are rejected for browser-facing endpoints.

Hard limits:
- request body size caps (JSON + uploads)
- output size caps (stdout/stderr truncation)
- timeouts + process kill for exec
- SSE event size caps
- rate limiting per token

Audit:
- append-only audit log of privileged actions (tool invocations, fs writes).

## Threat Model Checklist

- Drive-by web page attempts to call bridge (CORS + Origin + token binding).
- CSRF-style requests (require non-simple headers + token; reject missing Origin).
- Token theft via XSS in Meridian web app (minimize token lifetime, clear on disconnect; consider storing token in memory only).
- Command injection (`bash`) (structured args, allowlists, no shell expansion by default).
- Filesystem escape (`../`, symlinks) (jail to mount root; resolve realpath; policy on symlink traversal).
- DoS (many requests, huge outputs, long-running processes) (limits + rate limit + timeouts).

## Stage Exit Criteria

- Approved: API surface + permissions model + rollout plan (feature flags).
- Approved: filesystem mapping rules and conflict strategy (hash-based).

