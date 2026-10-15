/** Regression risks: detached checkouts aliasing main, and foreign routes passing readiness. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { pidBelongsToCheckout } from "./lib/route-ownership";
import { resolveCheckoutPortlessPrefix } from "./portless-prefix";
import { validateExpectedRoutes } from "./portless-routes";

it("separates main and two detached worktrees at the same commit", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "portless-ownership-")));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const main = path.join(root, "main");
    git(root, "init", "-q", main);
    git(
      main,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    );
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    git(main, "worktree", "add", "--detach", first, "HEAD");
    git(main, "worktree", "add", "--detach", second, "HEAD");
    expect(resolveCheckoutPortlessPrefix(main)).toBeUndefined();
    const prefix = resolveCheckoutPortlessPrefix(first);
    expect(prefix).toMatch(/^detached-[a-f0-9]+-first-[a-f0-9]+$/);
    expect(resolveCheckoutPortlessPrefix(second)).not.toBe(prefix);
    git(first, "switch", "-c", "fix/named");
    expect(resolveCheckoutPortlessPrefix(first)).toBe("named");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a foreign PID or wrong backend even when all expected hosts exist", () => {
  const output = [
    "https://app.meridian.localhost -> localhost:1234 (pid 123)",
    "https://server.meridian.localhost -> localhost:5678 (pid 456)",
  ].join("\n");
  expect(validateExpectedRoutes({ output, mode: "local", ownsPid: () => false }).ok).toBe(false);
  expect(
    validateExpectedRoutes({
      output,
      mode: "local",
      ownsPid: () => true,
      expectedPorts: { app: 9999 },
    }).ok,
  ).toBe(false);
  expect(
    validateExpectedRoutes({
      output,
      mode: "local",
      ownsPid: () => true,
      expectedPorts: { app: 1234 },
    }).ok,
  ).toBe(true);
  expect(pidBelongsToCheckout(process.pid, process.cwd())).toBe(true);
  expect(pidBelongsToCheckout(0, process.cwd())).toBe(false);
});
