/** Dev structured-event mirror location resolution (issue #330). */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevLogDir } from "./dev-env";

const REPO_ROOT = "/repo/root";
const CANONICAL = path.join(REPO_ROOT, "logs", "events");

describe("resolveDevLogDir", () => {
  it("defaults to the canonical repo-root logs/events dir", () => {
    expect(resolveDevLogDir(REPO_ROOT)).toBe(CANONICAL);
  });

  it("ignores a relative override so the mirror never scatters per service cwd", () => {
    // app/server/www each run in their own package cwd via `pnpm --filter`; a
    // relative LOG_DIR (e.g. a stale `.env` `LOG_DIR=logs`) would land in each
    // service's dir instead of the one repo-root tree probes read.
    expect(resolveDevLogDir(REPO_ROOT, "logs")).toBe(CANONICAL);
    expect(resolveDevLogDir(REPO_ROOT, "logs/events")).toBe(CANONICAL);
    expect(resolveDevLogDir(REPO_ROOT, "  ")).toBe(CANONICAL);
    expect(resolveDevLogDir(REPO_ROOT, "")).toBe(CANONICAL);
  });

  it("honors an absolute override verbatim", () => {
    expect(resolveDevLogDir(REPO_ROOT, "/custom/events")).toBe("/custom/events");
  });
});
