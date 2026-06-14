import { describe, expect, it } from "vitest";
import { resolveSessionIdentity } from "./session-identity";

describe("resolveSessionIdentity", () => {
  it("uses deterministic worktree-scoped names", () => {
    const a = resolveSessionIdentity({
      branchName: "feature/thread-first-chat",
      repoRootRealpath: "/tmp/worktrees/thread-first-chat",
    });

    const b = resolveSessionIdentity({
      branchName: "feature/thread-first-chat",
      repoRootRealpath: "/tmp/worktrees/thread-first-chat",
    });

    expect(a.sessionName).toBe(b.sessionName);
  });

  it("changes session name for same branch in another worktree", () => {
    const a = resolveSessionIdentity({
      branchName: "feature/thread-first-chat",
      repoRootRealpath: "/tmp/worktrees/thread-first-chat-a",
    });

    const b = resolveSessionIdentity({
      branchName: "feature/thread-first-chat",
      repoRootRealpath: "/tmp/worktrees/thread-first-chat-b",
    });

    expect(a.sessionName).not.toBe(b.sessionName);
  });

  it("does not duplicate slug when branch tail matches worktree basename", () => {
    const identity = resolveSessionIdentity({
      branchName: "feature/thread-first-chat",
      repoRootRealpath: "/tmp/worktrees/thread-first-chat",
    });

    expect(identity.slug).toBe("thread-first-chat");
    expect(identity.sessionName).toMatch(/^meridian-thread-first-chat-[a-f0-9]{8}$/);
  });

  it("includes sanitized branch/worktree labels and hash suffix", () => {
    const identity = resolveSessionIdentity({
      branchName: "Feature/API WS",
      repoRootRealpath: "/tmp/worktrees/Secondary Checkout",
    });

    expect(identity.slug).toContain("api-ws-secondary-checkout");
    expect(identity.sessionName).toMatch(/^meridian-[a-z0-9-]+-[a-f0-9]{8}$/);
  });

  it("uses detached fallback labels", () => {
    const identity = resolveSessionIdentity({
      branchName: "HEAD",
      detachedHeadRef: "a1b2c3d",
      repoRootRealpath: "/tmp/worktrees/detached",
    });

    expect(identity.sessionName).toContain("detached-a1b2c3d");
  });

  it("falls back to tmux-safe labels when branch and basename sanitize empty", () => {
    const identity = resolveSessionIdentity({
      branchName: "///",
      repoRootRealpath: "/",
    });

    expect(identity.sessionName).toContain("branch-worktree");
    expect(identity.sessionName).toMatch(/^meridian-[a-z0-9-]+-[a-f0-9]{8}$/);
  });
});
