import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideAutoCleanupReadiness,
  inspectAutoCleanupReadiness,
} from "./worktree-cleanup-readiness";

function temporaryRepository(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-readiness-"));
  const result = spawnSync("git", ["init", "--quiet"], { cwd: repo });
  if (result.status !== 0) throw new Error("could not initialize test repository");
  return repo;
}

async function waitForOutput(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
  });
}

describe("decideAutoCleanupReadiness", () => {
  it("requires a clean worktree with no owner or liveness evidence", () => {
    expect(
      decideAutoCleanupReadiness({
        worktreePath: "/repo/wt/stale",
        clean: true,
        activeWorkItemIds: [],
        liveDevSessionNames: [],
        liveProcessIds: [],
        inspectionFailures: [],
      }),
    ).toEqual({
      ready: true,
      evidence: { worktreePath: "/repo/wt/stale" },
    });
  });

  it("reports every gate that makes auto cleanup unsafe", () => {
    expect(
      decideAutoCleanupReadiness({
        worktreePath: "/repo/wt/live",
        clean: false,
        activeWorkItemIds: ["backlog-audit"],
        liveDevSessionNames: ["meridian-live"],
        liveProcessIds: [1234, 5678],
        inspectionFailures: ["process cwd scan incomplete"],
      }),
    ).toEqual({
      ready: false,
      reasons: [
        "worktree has uncommitted changes",
        "active Meridian work items: backlog-audit",
        "live dev sessions: meridian-live",
        "live processes have cwd under worktree: 1234, 5678",
        "process cwd scan incomplete",
      ],
    });
  });

  it("detects a dirty worktree from git state", () => {
    const repo = temporaryRepository();
    try {
      fs.writeFileSync(path.join(repo, "unsaved.txt"), "draft");
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining(["worktree has uncommitted changes"]),
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("detects a live process whose cwd is under the worktree", async () => {
    const repo = temporaryRepository();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: repo,
      stdio: "ignore",
    });
    try {
      let decision = inspectAutoCleanupReadiness(repo, []);
      for (let attempt = 0; decision.ready && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        decision = inspectAutoCleanupReadiness(repo, []);
      }
      expect(decision).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`live processes have cwd under worktree:.*\\b${child.pid}\\b`),
          ),
        ]),
      });
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed when a same-user process hides its cwd", async () => {
    const repo = temporaryRepository();
    const child = spawn(
      "python3",
      [
        "-c",
        [
          "import ctypes, time",
          "ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)",
          "print('ready', flush=True)",
          "time.sleep(30)",
        ].join("; "),
      ],
      { cwd: repo, stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await waitForOutput(child);
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`could not inspect cwd for same-user processes:.*\\b${child.pid}\\b`),
          ),
        ]),
      });
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
