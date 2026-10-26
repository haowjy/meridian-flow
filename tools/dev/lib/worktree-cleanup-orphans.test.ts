import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionIdentity } from "../session-identity";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const cli = path.join(checkout, "tools/dev/prune-worktrees.ts");
const tsx = path.join(checkout, "node_modules/tsx/dist/cli.mjs");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!hasTmux)("orphan dev session cleanup (isolated tmux server)", () => {
  let temp: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  function run(command: string, args: string[], cwd = repo) {
    return spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 15_000, input: "\n" });
  }

  function initRepo(root: string) {
    fs.mkdirSync(root, { recursive: true });
    expect(run("git", ["init", "--quiet"], root).status).toBe(0);
    expect(
      run(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-qm",
          "fixture",
        ],
        root,
      ).status,
    ).toBe(0);
  }

  function tmux(...args: string[]): string {
    const result = run("tmux", args);
    if (result.status !== 0) throw new Error(result.stderr || "tmux failed");
    return result.stdout.trim();
  }

  function session(root: string, name?: string, command = "sleep 60"): string {
    fs.mkdirSync(root, { recursive: true });
    const sessionName =
      name ??
      resolveSessionIdentity({
        branchName: path.basename(root),
        repoRootRealpath: root,
      }).sessionName;
    tmux("new-session", "-d", "-s", sessionName, "-c", root, command);
    return sessionName;
  }

  function prune(...args: string[]) {
    return run(process.execPath, [tsx, cli, "--orphans", ...args]);
  }

  function stubbornSession(root: string, spawnChildOnTerm = false): string {
    const script = path.join(temp, "stubborn.mjs");
    fs.writeFileSync(
      script,
      `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const child = process.argv[2];
      let spawnedLate = false;
      function spawnChild(kind) {
        spawn(process.execPath, [import.meta.filename, kind], { detached: true, stdio: 'ignore' });
      }
      process.on('SIGTERM', () => {
        if (!child && ${spawnChildOnTerm} && !spawnedLate) {
          spawnedLate = true;
          spawnChild('late');
        }
      });
      process.on('SIGHUP', () => {});
      if (!child) spawnChild('child');
      fs.writeFileSync(${JSON.stringify(temp)} + '/' + (child || 'parent') + '.pid', String(process.pid));
      setInterval(() => {}, 1000);
    `,
    );
    return session(root, undefined, `${process.execPath} ${script}`);
  }

  function stopScript(body: string) {
    const runner = path.join(temp, "stop.mts");
    const module = path.join(checkout, "tools/dev/lib/worktree-cleanup-orphans.ts");
    fs.writeFileSync(
      runner,
      `
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { collectOrphanDevSessions, stopOrphanDevSessions } from ${JSON.stringify(module)};
      const plan = collectOrphanDevSessions(process.cwd());
      ${body}
    `,
    );
    return run(process.execPath, [tsx, runner]);
  }

  beforeEach(() => {
    // Keep the socket pathname under the POSIX Unix-socket length limit.
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-orphan-"));
    repo = path.join(temp, "repo");
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    // Stub only route maintenance; all tmux/process lifecycle operations are real.
    fs.writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\n[ "$*" = "exec portless prune" ]\n', {
      mode: 0o755,
    });
    env = {
      ...process.env,
      TMUX: "",
      TMUX_TMPDIR: temp,
      PATH: `${bin}:${process.env.PATH}`,
      LC_ALL: "C",
    };
    initRepo(repo);
    fs.mkdirSync(`${repo}.worktrees`);
  });

  afterEach(() => {
    run("tmux", ["kill-server"]);
    for (const name of ["parent.pid", "child.pid", "late.pid"]) {
      const file = path.join(temp, name);
      if (fs.existsSync(file)) {
        try {
          process.kill(Number(fs.readFileSync(file, "utf8")), "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("previews and cancels without mutation, then reclaims a deleted worktree container", () => {
    const root = `${repo}.worktrees/gone`;
    const name = session(root);
    fs.rmSync(`${repo}.worktrees`, { recursive: true });
    const preview = prune("--dry-run");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(name);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    const cancel = prune();
    expect(cancel.status, cancel.stderr).toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    const execute = prune("--yes");
    expect(execute.status, execute.stderr).toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
  });

  it("preserves live, foreign, unowned, locked and ambiguous sessions despite inherited Git overrides", () => {
    const live = session(`${repo}.worktrees/live`);
    const foreignRepo = path.join(temp, "foreign");
    initRepo(foreignRepo);
    const foreignRoot = `${foreignRepo}.worktrees/gone`;
    const foreign = session(foreignRoot);
    fs.rmSync(foreignRoot, { recursive: true });
    const userRoot = `${repo}.worktrees/user`;
    const user = session(userRoot, "user-session");
    fs.rmSync(userRoot, { recursive: true });
    const wrongRoot = `${repo}.worktrees/wrong-hash`;
    const wrong = session(wrongRoot, "meridian-gone-deadbeef");
    fs.rmSync(wrongRoot, { recursive: true });
    const movedRoot = `${repo}.worktrees/moved`;
    const moved = session(movedRoot);
    tmux("split-window", "-d", "-t", `=${moved}:0`, "-c", repo, "sleep 60");
    fs.rmSync(movedRoot, { recursive: true });
    const symlinkRoot = `${repo}.worktrees/link`;
    const symlink = session(symlinkRoot);
    fs.rmSync(symlinkRoot, { recursive: true });
    fs.symlinkSync(path.join(temp, "absent"), symlinkRoot);
    const lockedRoot = `${repo}.worktrees/locked`;
    expect(run("git", ["worktree", "add", "--quiet", "-b", "locked", lockedRoot]).status).toBe(0);
    const locked = session(lockedRoot);
    expect(run("git", ["worktree", "lock", lockedRoot]).status).toBe(0);
    fs.rmSync(lockedRoot, { recursive: true });
    env.GIT_DIR = path.join(foreignRepo, ".git");
    env.GIT_WORK_TREE = foreignRepo;
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    for (const name of [live, foreign, user, wrong, moved, symlink, locked]) {
      expect(run("tmux", ["has-session", "-t", `=${name}`]).status, name).toBe(0);
    }
  });

  it("refuses a stale plan when the checkout reappears before execution", () => {
    const root = `${repo}.worktrees/reappeared`;
    const name = session(root);
    fs.rmSync(root, { recursive: true });
    const result = stopScript(`
      fs.mkdirSync(${JSON.stringify(root)});
      await stopOrphanDevSessions(process.cwd(), plan);
    `);
    expect(result.status).not.toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
  });

  it("preserves a live-checkout pane added during shutdown", async () => {
    const root = `${repo}.worktrees/changed-panes`;
    const name = stubbornSession(root);
    await expect.poll(() => fs.existsSync(path.join(temp, "child.pid"))).toBe(true);
    fs.rmSync(root, { recursive: true });
    const livePidFile = path.join(temp, "live.pid");
    const result = stopScript(`
      setTimeout(() => {
        const pane = spawnSync('tmux', ['split-window', '-d', '-t', plan[0].sessionId + ':0',
          '-c', ${JSON.stringify(repo)}, '-P', '-F', '#{pane_pid}', 'sleep 60'], { encoding: 'utf8' });
        if (pane.status !== 0) throw new Error(pane.stderr);
        fs.writeFileSync(${JSON.stringify(livePidFile)}, pane.stdout.trim());
      }, 200);
      await stopOrphanDevSessions(process.cwd(), plan);
    `);
    expect(result.status).not.toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    const state = run("ps", [
      "-p",
      fs.readFileSync(livePidFile, "utf8"),
      "-o",
      "stat=",
    ]).stdout.trim();
    expect(state !== "" && !state.startsWith("Z")).toBe(true);
  });

  it("refuses exec identity changes across the grace deadline while retaining retry evidence", async () => {
    const root = `${repo}.worktrees/exec-at-deadline`;
    const script = path.join(temp, "exec.mjs");
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs';
      process.on('SIGHUP', () => {});
      process.on('SIGTERM', () => process.execve('/bin/sh',
        ['sh', '-c', "trap '' HUP TERM; exec sleep 60"], process.env));
      fs.writeFileSync(${JSON.stringify(path.join(temp, "parent.pid"))}, String(process.pid));
      setInterval(() => {}, 1000);
    `,
    );
    const name = session(root, undefined, `${process.execPath} ${script}`);
    await expect.poll(() => fs.existsSync(path.join(temp, "parent.pid"))).toBe(true);
    const pid = fs.readFileSync(path.join(temp, "parent.pid"), "utf8").trim();
    fs.rmSync(root, { recursive: true });
    const result = stopScript(`
      await stopOrphanDevSessions(process.cwd(), plan, (line) => {
        if (line.startsWith('SIGTERM')) {
          process.kill(${Number(pid)}, 'SIGTERM');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
        }
      });
    `);
    expect(result.status).not.toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    expect(run("ps", ["-p", pid, "-o", "comm="]).stdout.trim()).toMatch(/(^|\/)sleep$/);
  });

  it("reclaims initial and TERM-spawned detached children without touching a live session", async () => {
    const root = `${repo}.worktrees/stubborn`;
    const name = stubbornSession(root, true);
    const live = session(`${repo}.worktrees/live`);
    await expect.poll(() => fs.existsSync(path.join(temp, "child.pid"))).toBe(true);
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    for (const file of ["parent.pid", "child.pid", "late.pid"]) {
      const pid = fs.readFileSync(path.join(temp, file), "utf8").trim();
      // A reparented zombie has exited, even if init hasn't reaped it yet.
      const state = run("ps", ["-p", pid, "-o", "stat="]).stdout.trim();
      expect(state === "" || state.startsWith("Z"), file).toBe(true);
    }
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${live}`]).status).toBe(0);
  });

  it("tolerates route contention, retries with zero orphans and leaves dry-run non-mutating", () => {
    const root = `${repo}.worktrees/route-lock`;
    const name = session(root);
    const called = path.join(temp, "route-prune.called");
    fs.writeFileSync(
      path.join(temp, "bin/pnpm"),
      `#!/bin/sh\ntouch ${JSON.stringify(called)}\necho 'Failed to acquire route lock' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Failed to acquire route lock");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
    fs.rmSync(called);
    const retry = prune("--yes");
    expect(retry.status, retry.stderr).toBe(0);
    expect(fs.existsSync(called)).toBe(true);
    fs.rmSync(called);
    expect(prune("--dry-run").status).toBe(0);
    expect(fs.existsSync(called)).toBe(false);
  });

  it("resumes its paused parent on refusal but leaves an externally stopped child alone", async () => {
    const root = `${repo}.worktrees/resume-on-refusal`;
    stubbornSession(root);
    await expect.poll(() => fs.existsSync(path.join(temp, "child.pid"))).toBe(true);
    process.kill(Number(fs.readFileSync(path.join(temp, "child.pid"), "utf8")), "SIGSTOP");
    fs.rmSync(root, { recursive: true });
    const result = stopScript(`
      await stopOrphanDevSessions(process.cwd(), plan, (line) => {
        if (line.startsWith('SIGSTOP')) fs.mkdirSync(${JSON.stringify(root)}, { recursive: true });
      });
    `);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(root)).toBe(true);
    for (const file of ["parent.pid", "child.pid"]) {
      const pid = fs.readFileSync(path.join(temp, file), "utf8").trim();
      const state = run("ps", ["-p", pid, "-o", "stat="]).stdout.trim();
      if (file === "child.pid") expect(state).toMatch(/^[Tt]/);
      else expect(state !== "" && !/^[TtZ]/.test(state)).toBe(true);
    }
  });
});
