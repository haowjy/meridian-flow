import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

function resolveAppUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit;

  try {
    const output = execFileSync("pnpm", ["portless:list"], { encoding: "utf8" });
    const routes = output
      .split("\n")
      .map((line) => /^\s*(https:\/\/\S+)\s+->/.exec(line)?.[1])
      .filter((url): url is string => Boolean(url))
      .filter((url) => {
        const hostname = new URL(url).hostname;
        return (
          hostname === "app.meridian.localhost" || hostname.endsWith(".app.meridian.localhost")
        );
      });

    if (routes.length === 1) return routes[0];
    const stable = routes.find((url) => new URL(url).hostname === "app.meridian.localhost");
    if (stable) return stable;
  } catch {
    // Loading the config should not fail before the dev stack is up. The test
    // run itself will fail clearly if this default route is not active.
  }

  return "https://app.meridian.localhost";
}

export default defineConfig({
  testDir: "apps/app/e2e",
  testMatch: ["auth.spec.ts", "phase5.spec.ts", "vertical-slice.spec.ts"],
  timeout: 30_000,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: resolveAppUrl(),
    ignoreHTTPSErrors: true,
    ...devices["Desktop Chrome"],
  },
});
