# E2E Tests

Playwright browser tests. Requires both frontend and backend running.

## Setup

```bash
cd tests/e2e
pnpm install
npx playwright install chromium
```

## Running

```bash
# All E2E tests
npx playwright test --config tests/e2e/playwright.config.ts

# Collab only
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/collab/
```

## Key Capabilities

- **Multi-context**: two browser contexts = two users on same doc
- **`routeWebSocket`**: intercept/delay/drop/corrupt WS frames in-flight
- **Network interception**: `page.route` to simulate offline
- **CDP**: heap snapshots for memory leak detection

## Directory Layout

```
e2e/
  playwright.config.ts
  collab/
    basic.spec.ts             open doc, type, refresh, verify persisted
    two-tabs.spec.ts          two contexts, type in each, verify convergence
    offline.spec.ts           block WS, type offline, unblock, verify merge
    proposal-review.spec.ts   trigger proposal, accept/reject via UI
    resilience.spec.ts        routeWebSocket fault injection
```
