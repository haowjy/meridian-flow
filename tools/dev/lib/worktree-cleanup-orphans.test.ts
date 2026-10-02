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

  function tmux(...args: string[]): string {
    const result = run("tmux", args);
    if (result.status !== 0) throw new Error(result.stderr || "tmux failed");
    return result.stdout.trim();
  }

  function session(root: string, name?: string, command = "sleep 60"): string {
    fs.mkdirSync(root, { recursive: true });
    const sessionName =
      name ??
      resolveSessionIdentity({ branchName: path.basename(root), repoRootRealpath: root })
        .sessionName;
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
      const child = process.argv.includes('--child');
      let spawned = false;
      function spawnChild() {
        if (child || spawned) return;
        spawned = true;
        spawn(process.execPath, [import.meta.filename, '--child'], { detached: true, stdio: 'ignore' });
      }
      process.on('SIGTERM', () => { if (${spawnChildOnTerm}) spawnChild(); });
      process.on('SIGHUP', () => {});
      if (!${spawnChildOnTerm}) spawnChild();
      const dir = ${JSON.stringify(temp)};
      fs.writeFileSync(dir + (child ? '/child.pid' : '/parent.pid'), String(process.pid));
      setInterval(() => {}, 1000);
    `,
    );
    return session(root, undefined, `${process.execPath} ${script}`);
  }

  function execSession(root: string): string {
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
    fs.mkdirSync(repo);
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
    expect(run("git", ["init", "--quiet"]).status).toBe(0);
    expect(
      run("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ]).status,
    ).toBe(0);
    fs.mkdirSync(`${repo}.worktrees`);
  });

  afterEach(() => {
    run("tmux", ["kill-server"]);
    for (const name of ["parent.pid", "child.pid"]) {
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

  it("dry-runs an unregistered deleted checkout without stopping its session", () => {
    const root = `${repo}.worktrees/gone`;
    const name = session(root);
    fs.rmSync(root, { recursive: true });
    const result = prune("--dry-run");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`session: ${name}`);
    expect(result.stdout).toContain("Dry run only; no changes made.");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    const cancel = prune();
    expect(cancel.status, cancel.stderr).toBe(0);
    expect(cancel.stdout).toContain("Aborted. No changes made.");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
  });

  it("ignores live checkouts, foreign repos, unowned names, changed pane locations and dangling symlinks", () => {
    const live = session(`${repo}.worktrees/live`);
    const foreignRoot = path.join(temp, "other.worktrees/gone");
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
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No orphan dev sessions found.");
    for (const name of [live, foreign, user, wrong, moved, symlink]) {
      expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    }
  });

  it("preserves a locked missing registered checkout", () => {
    const root = `${repo}.worktrees/locked`;
    expect(run("git", ["worktree", "add", "--quiet", "-b", "locked", root]).status).toBe(0);
    const name = session(root);
    expect(run("git", ["worktree", "lock", root]).status).toBe(0);
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No orphan dev sessions found.");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
  });

  it("stops a responsive orphan even when SIGTERM also removes the tmux session", () => {
    const root = `${repo}.worktrees/responsive`;
    const name = session(root);
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("cleanup complete");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
  });

  it("force-kills captured detached children that ignore TERM/HUP while preserving a live session", async () => {
    const root = `${repo}.worktrees/stubborn`;
    const name = stubbornSession(root);
    const live = session(`${repo}.worktrees/live`);
    await expect.poll(() => fs.existsSync(path.join(temp, "child.pid"))).toBe(true);
    const pids = ["parent.pid", "child.pid"].map((file) =>
      Number(fs.readFileSync(path.join(temp, file), "utf8")),
    );
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    for (const pid of pids) {
      expect(result.stdout).toContain(`SIGKILL PID ${pid}`);
      // A reparented zombie has exited, even if init hasn't reaped it yet.
      const state = run("ps", ["-p", String(pid), "-o", "stat="]).stdout.trim();
      expect(state === "" || state.startsWith("Z")).toBe(true);
    }
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
    expect(run("tmux", ["has-session", "-t", `=${live}`]).status).toBe(0);
    expect(prune("--yes").stdout).toContain("No orphan dev sessions found.");
  }, 20_000);

  it("reclaims an orphan when the entire sibling worktree container was deleted", () => {
    const root = `${repo}.worktrees/container-gone`;
    const name = session(root);
    fs.rmSync(`${repo}.worktrees`, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Stopping orphan dev session ${name}`);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
  });

  it("refuses an orphan plan if its checkout reappears before execution", () => {
    const root = `${repo}.worktrees/reappeared`;
    const name = session(root);
    fs.rmSync(root, { recursive: true });
    const runner = path.join(temp, "race.mts");
    const module = path.join(checkout, "tools/dev/lib/worktree-cleanup-orphans.ts");
    fs.writeFileSync(
      runner,
      `
      import fs from 'node:fs';
      import { collectOrphanDevSessions, stopOrphanDevSessions } from ${JSON.stringify(module)};
      const plan = collectOrphanDevSessions(process.cwd());
      fs.mkdirSync(${JSON.stringify(root)});
      await stopOrphanDevSessions(process.cwd(), plan);
    `,
    );
    const result = run(process.execPath, [tsx, runner]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Orphan session ownership changed");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
  });

  it("ignores inherited Git repository overrides when scoping orphan cleanup", () => {
    const foreign = path.join(temp, "foreign");
    fs.mkdirSync(foreign);
    expect(run("git", ["init", "--quiet"], foreign).status).toBe(0);
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
          "foreign",
        ],
        foreign,
      ).status,
    ).toBe(0);
    const root = `${foreign}.worktrees/gone`;
    const name = session(root);
    fs.rmSync(root, { recursive: true });
    env.GIT_DIR = path.join(foreign, ".git");
    env.GIT_WORK_TREE = foreign;
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No orphan dev sessions found.");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
  });

  it("preserves a live-checkout pane added during the TERM grace period", async () => {
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
    expect(result.stderr).toContain("Orphan session ownership changed");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    const livePid = fs.readFileSync(livePidFile, "utf8");
    const state = run("ps", ["-p", livePid, "-o", "stat="]).stdout.trim();
    expect(state !== "" && !state.startsWith("Z")).toBe(true);
  });

  it("refuses a captured executable change instead of reporting a live process as exited", async () => {
    const root = `${repo}.worktrees/exec-on-term`;
    const name = execSession(root);
    await expect.poll(() => fs.existsSync(path.join(temp, "parent.pid"))).toBe(true);
    const pid = fs.readFileSync(path.join(temp, "parent.pid"), "utf8").trim();
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Captured process identity changed");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    expect(run("ps", ["-p", pid, "-o", "comm="]).stdout.trim()).toMatch(/(^|\/)sleep$/);
    // A newly inspected plan can authorize the replacement without treating
    // the original identity mismatch as proof of exit or permission to kill.
    const retry = prune("--yes");
    expect(retry.status, retry.stderr).toBe(0);
    const state = run("ps", ["-p", pid, "-o", "stat="]).stdout.trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("refreshes identities before teardown when signaling crosses the grace deadline", async () => {
    const root = `${repo}.worktrees/exec-at-deadline`;
    const name = execSession(root);
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
    expect(result.stderr).toContain("Captured process identity changed");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).toBe(0);
    expect(run("ps", ["-p", pid, "-o", "comm="]).stdout.trim()).toMatch(/(^|\/)sleep$/);
    const retry = prune("--yes");
    expect(retry.status, retry.stderr).toBe(0);
    const state = run("ps", ["-p", pid, "-o", "stat="]).stdout.trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("captures and stops detached children spawned by a TERM handler", async () => {
    const root = `${repo}.worktrees/late-child`;
    const name = stubbornSession(root, true);
    await expect.poll(() => fs.existsSync(path.join(temp, "parent.pid"))).toBe(true);
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    const pid = Number(fs.readFileSync(path.join(temp, "child.pid"), "utf8"));
    expect(result.stdout).toContain(`SIGKILL PID ${pid}`);
    const state = run("ps", ["-p", String(pid), "-o", "stat="]).stdout.trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
  });

  it("warns on route contention and retries maintenance even after all orphans are gone", () => {
    const root = `${repo}.worktrees/route-lock`;
    const name = session(root);
    const calls = path.join(temp, "route-prune.calls");
    fs.writeFileSync(
      path.join(temp, "bin/pnpm"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\necho 'Failed to acquire route lock' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    fs.rmSync(root, { recursive: true });
    const result = prune("--yes");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("cleanup complete");
    expect(result.stderr).toContain("portless prune warning: Failed to acquire route lock");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
    const retry = prune("--yes");
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain("No orphan dev sessions found.");
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(prune("--dry-run").status).toBe(0);
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it.each([
    false,
    true,
  ])("resumes only its own paused survivors on refusal (externally paused child: %s)", async (pauseChild) => {
    const root = `${repo}.worktrees/resume-on-refusal`;
    const name = stubbornSession(root);
    await expect.poll(() => fs.existsSync(path.join(temp, "child.pid"))).toBe(true);
    if (pauseChild)
      process.kill(Number(fs.readFileSync(path.join(temp, "child.pid"), "utf8")), "SIGSTOP");
    fs.rmSync(root, { recursive: true });
    const result = stopScript(`
        await stopOrphanDevSessions(process.cwd(), plan, (line) => {
          if (line.startsWith('SIGSTOP')) fs.mkdirSync(${JSON.stringify(root)}, { recursive: true });
        });
      `);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Orphan session ownership changed");
    expect(run("tmux", ["has-session", "-t", `=${name}`]).status).not.toBe(0);
    expect(fs.existsSync(root)).toBe(true);
    for (const file of ["parent.pid", "child.pid"]) {
      const pid = fs.readFileSync(path.join(temp, file), "utf8").trim();
      const state = run("ps", ["-p", pid, "-o", "stat="]).stdout.trim();
      if (pauseChild && file === "child.pid") expect(state).toMatch(/^[Tt]/);
      else expect(state !== "" && !/^[TZ]/.test(state)).toBe(true);
    }
  });

  it("does nothing without a tmux server and rejects mixed cleanup modes", () => {
    expect(prune("--yes").status).toBe(0);
    const result = prune("--auto", "--acknowledge-batch-risk");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--orphans cannot be combined");
  });
});
