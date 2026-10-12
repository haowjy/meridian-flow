import { defineConfig } from "vitest/config";

// vi.mock is file-scoped only when the file has its own module graph.
// These stay isolated so a Stripe or auth mock cannot leak into the shared server run.
export default defineConfig({
  test: {
    name: "@meridian/server-isolated",
    isolate: true,
    include: [
      "server/lib/auth.test.ts",
      "server/lib/context-work-refusal.test.ts",
      "server/lib/model-tools/shown-link-capture.test.ts",
      "server/domains/billing/adapters/stripe/stripe-gateway.test.ts",
      "server/routes/api/threads/[[]threadId]/messages.post.test.ts",
    ],
    testTimeout: 30_000,
  },
});
