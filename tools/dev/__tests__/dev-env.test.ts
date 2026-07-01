import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as devEnv from "../lib/dev-env";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

describe("dev-env", () => {
  it("rewrites database URLs idempotently for worktrees", () => {
    const baseUrl = "postgresql://postgres:postgres@127.0.0.1:54422/meridian";
    const scopedUrl = devEnv.applyWorktreeDatabaseRewrite(baseUrl, "meridian_thread-first-chat");
    expect(scopedUrl).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54422/meridian_thread-first-chat",
    );
    expect(devEnv.applyWorktreeDatabaseRewrite(scopedUrl, "meridian_thread-first-chat")).toBe(
      scopedUrl,
    );
  });
  it("scopes worktree URLs using the main-checkout base name even when already rewritten", () => {
    const mainBaseUrl = "postgresql://postgres:postgres@127.0.0.1:54422/meridian";
    const scoped = devEnv.applyWorktreeDatabaseRewrite(
      mainBaseUrl,
      devEnv.resolveWorktreeDatabaseName("meridian", "feat-api"),
    );
    expect(scoped).toBe("postgresql://postgres:postgres@127.0.0.1:54422/meridian_feat-api");
    expect(
      devEnv.applyWorktreeDatabaseRewrite(
        scoped,
        devEnv.resolveWorktreeDatabaseName("meridian", "feat-api"),
      ),
    ).toBe(scoped);
  });
  it("runs direnv allow when direnv is installed", () => {
    const exec = vi.mocked(execFileSync);
    exec.mockImplementationOnce(() => "");
    devEnv.ensureDirenvAllowed("/tmp/meridian-flow");
    expect(exec).toHaveBeenCalledWith("direnv", ["allow", "/tmp/meridian-flow"], {
      stdio: "ignore",
    });
  });

  it("skips direnv allow when direnv is not installed", () => {
    const exec = vi.mocked(execFileSync);
    exec.mockImplementationOnce(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => devEnv.ensureDirenvAllowed("/tmp/meridian-flow")).not.toThrow();
  });
});
