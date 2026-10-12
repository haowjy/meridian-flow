import { configDefaults, defineConfig } from "vitest/config";

const mockedModules = [
  "server/lib/auth.test.ts",
  "server/lib/context-work-refusal.test.ts",
  "server/lib/model-tools/shown-link-capture.test.ts",
  "server/domains/billing/adapters/stripe/stripe-gateway.test.ts",
  "server/routes/api/threads/[[]threadId]/messages.post.test.ts",
];

export default defineConfig({
  test: {
    name: "@meridian/server",
    // Reuse the module graph across files. The five vi.mock files stay in
    // vitest.isolated.config.ts; a shared worker would leak those mocks.
    isolate: false,
    // .output is nitro's build artifact; its compiled *.test.mjs copies must not be collected.
    exclude: [...configDefaults.exclude, "**/*.db.test.ts", "**/.output/**", ...mockedModules],
    testTimeout: 30_000,
  },
});
