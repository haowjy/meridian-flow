/** Server unit tests that mock modules. They must not share the isolate:false graph. */

export const mockedServerTests = [
  "server/lib/auth.test.ts",
  "server/lib/context-work-refusal.test.ts",
  "server/lib/model-tools/shown-link-capture.test.ts",
  "server/domains/billing/adapters/stripe/stripe-gateway.test.ts",
  "server/routes/api/threads/[threadId]/messages.post.test.ts",
  "server/routes/api/projects/[projectId]/imports/index.get.test.ts",
];

/** Vitest include/exclude treats brackets as character classes. */
export function asVitestGlob(path: string): string {
  return path.replaceAll("[", "[[]");
}
