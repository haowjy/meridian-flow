import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectAutoCleanupReadiness,
  decideAutoCleanupReadiness,
  inspectAutoCleanupReadiness,
  inspectCleanupCleanliness,
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

function spawnWithHiddenCwd(...args: string[]): ReturnType<typeof spawn> {
  return spawn(
    "python3",
    [
      "-c",
      [
        "import ctypes, time",
        "ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)",
        "print('ready', flush=True)",
        "time.sleep(30)",
      ].join("; "),
      ...args,
    ],
    { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "ignore"] },
  );
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
        liveProcessCommandLineIds: [],
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
        liveProcessCommandLineIds: [9012],
        inspectionFailures: ["process cwd scan incomplete"],
      }),
    ).toEqual({
      ready: false,
      reasons: [
        "worktree has uncommitted changes",
        "active Meridian work items: backlog-audit",
        "live dev sessions: meridian-live",
        "live processes have cwd under worktree: 1234, 5678",
        "live processes reference worktree path: 9012",
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

  it("reports missing tmux server state as no live sessions", () => {
    const repo = temporaryRepository();
    const tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-tmux-"));
    const previousTmux = process.env.TMUX;
    const previousTmuxTmpDir = process.env.TMUX_TMPDIR;
    try {
      delete process.env.TMUX;
      process.env.TMUX_TMPDIR = tmuxTmpDir;
      expect(inspectAutoCleanupReadiness(repo, [])).toEqual({
        ready: true,
        evidence: { worktreePath: repo },
      });
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previousTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpDir;
      fs.rmSync(tmuxTmpDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still blocks when a tmux socket exists but the query fails", () => {
    const repo = temporaryRepository();
    const socketPath = path.join(os.tmpdir(), `meridian-tmux-socket-${process.pid}`);
    const previousTmux = process.env.TMUX;
    try {
      fs.writeFileSync(socketPath, "not a tmux socket");
      process.env.TMUX = `${socketPath},1,0`;
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(/^could not inspect tmux dev sessions/),
        ]),
      });
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      fs.rmSync(socketPath, { force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still blocks when a live tmux server has lost its socket", () => {
    const repo = temporaryRepository();
    const tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-tmux-"));
    const socketPath = path.join(tmuxTmpDir, `tmux-${process.getuid?.()}`, "default");
    const previousTmux = process.env.TMUX;
    const previousTmuxTmpDir = process.env.TMUX_TMPDIR;
    let serverPid: number | undefined;
    try {
      const env = { ...process.env, TMUX: "", TMUX_TMPDIR: tmuxTmpDir };
      const start = spawnSync("tmux", ["new-session", "-d", "-s", "meridian-readiness"], {
        cwd: os.tmpdir(),
        env,
      });
      if (start.status !== 0) throw new Error("could not start isolated tmux server");
      const pid = spawnSync("tmux", ["display-message", "-p", "#{pid}"], {
        env,
        encoding: "utf8",
      });
      serverPid = Number(pid.stdout.trim());
      fs.unlinkSync(socketPath);

      delete process.env.TMUX;
      process.env.TMUX_TMPDIR = tmuxTmpDir;
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(/^could not inspect tmux dev sessions/),
        ]),
      });
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previousTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previousTmuxTmpDir;
      if (serverPid && Number.isSafeInteger(serverPid)) process.kill(serverPid, "SIGTERM");
      fs.rmSync(tmuxTmpDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("checks target cleanliness without applying auto-only ownership gates", () => {
    const repo = temporaryRepository();
    try {
      expect(inspectCleanupCleanliness(repo)).toEqual({
        ready: true,
        evidence: { worktreePath: repo },
      });
      fs.writeFileSync(path.join(repo, "unsaved.txt"), "draft");
      expect(inspectCleanupCleanliness(repo)).toEqual({
        ready: false,
        reasons: ["worktree has uncommitted changes"],
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

  it("does not block for a same-user process with an unreadable cwd unrelated to the worktree", async () => {
    const repo = temporaryRepository();
    const child = spawnWithHiddenCwd();
    try {
      await waitForOutput(child);
      expect(inspectAutoCleanupReadiness(repo, [])).toEqual({
        ready: true,
        evidence: { worktreePath: repo },
      });
      const collection = collectAutoCleanupReadiness([repo], [], repo);
      expect(collection.decisions.get(repo)).toEqual({
        ready: true,
        evidence: { worktreePath: repo },
      });
      expect(collection.caveats).toEqual([
        expect.stringMatching(
          new RegExp(
            `^could not inspect cwd for same-user processes not attributed to a worktree:.*\\b${child.pid}\\b`,
          ),
        ),
      ]);
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("blocks when a same-user process with an unreadable cwd names the worktree", async () => {
    const repo = temporaryRepository();
    const child = spawnWithHiddenCwd(repo);
    try {
      await waitForOutput(child);
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`live processes reference worktree path:.*\\b${child.pid}\\b`),
          ),
        ]),
      });
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("recognizes a worktree path next to a shell operator", async () => {
    const repo = temporaryRepository();
    const child = spawnWithHiddenCwd(`ls ${repo}>/tmp/meridian-review.log`);
    try {
      await waitForOutput(child);
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`live processes reference worktree path:.*\\b${child.pid}\\b`),
          ),
        ]),
      });
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("recognizes a worktree path in a file URI", async () => {
    const repo = temporaryRepository();
    const child = spawnWithHiddenCwd(pathToFileURL(repo).href);
    try {
      await waitForOutput(child);
      expect(inspectAutoCleanupReadiness(repo, [])).toMatchObject({
        ready: false,
        reasons: expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`live processes reference worktree path:.*\\b${child.pid}\\b`),
          ),
        ]),
      });
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not mistake a worktree path embedded in a longer path for the target", async () => {
    const repo = temporaryRepository();
    const child = spawnWithHiddenCwd(`/shadow${repo}`);
    try {
      await waitForOutput(child);
      expect(inspectAutoCleanupReadiness(repo, [])).toEqual({
        ready: true,
        evidence: { worktreePath: repo },
      });
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
