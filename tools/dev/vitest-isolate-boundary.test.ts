/** A shared Vitest module graph must not load vi.mock. One missed file can call a real provider.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Mock-bearing tests use isolated Vitest module graphs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import sharedServerConfig from "../../apps/server/vitest.config";
import isolatedServerConfig from "../../apps/server/vitest.isolated.config";
import { asVitestGlob, mockedServerTests } from "../../apps/server/vitest.mocked-files";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleMock = /\bvi\s*\.\s*(?:mock|doMock)\s*\(/;

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".output" || entry.name === "dist")
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

function isolateFalseRoots(): string[] {
  const roots = new Set<string>();
  for (const path of walk(repoRoot)) {
    if (!path.endsWith(".ts") || !path.includes("vitest")) continue;
    if (!/vitest(?:\.[^/]+)?\.config\.ts$/.test(path) && !path.endsWith("vitest.config.mts"))
      continue;
    if (/isolate:\s*false/.test(readFileSync(path, "utf8"))) roots.add(dirname(path));
  }
  return [...roots];
}

it("rejects module mocks in isolate: false projects", () => {
  const allowed = new Set(mockedServerTests.map((file) => join(repoRoot, "apps/server", file)));
  const leaks = isolateFalseRoots().flatMap((root) =>
    walk(root).flatMap((path) => {
      if (!/\.(?:ts|tsx|mts)$/.test(path) || allowed.has(path)) return [];
      return moduleMock.test(readFileSync(path, "utf8")) ? [relative(repoRoot, path)] : [];
    }),
  );
  expect(leaks).toEqual([]);
});

it("keeps mocked server tests in exactly the isolated project", () => {
  if (typeof sharedServerConfig === "function" || typeof isolatedServerConfig === "function") {
    throw new Error("server Vitest configs must remain static objects");
  }
  expect(sharedServerConfig.test?.isolate).toBe(false);
  expect(isolatedServerConfig.test?.isolate).toBe(true);
  for (const file of mockedServerTests) {
    const glob = asVitestGlob(file);
    expect(sharedServerConfig.test?.exclude).toContain(glob);
    expect(isolatedServerConfig.test?.include).toContain(glob);
    expect(moduleMock.test(readFileSync(join(repoRoot, "apps/server", file), "utf8"))).toBe(true);
  }
  expect(asVitestGlob("server/routes/api/threads/[threadId]/messages.post.test.ts")).toBe(
    "server/routes/api/threads/[[]threadId]/messages.post.test.ts",
  );
});
