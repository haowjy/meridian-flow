import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { devTmuxArgs, legacyDefaultServerArgs } from "./lib/dev-tmux-socket";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const TMUX_ENV_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "TMUX_TMPDIR",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
]);

/**
 * The environment tmux runs with. The first tmux call starts the shared dev server,
 * which keeps its caller's environment as its global one and hands it to every
 * window opened later, from any checkout. A fixed allowlist makes that environment
 * the same whichever checkout started the server, with no caller overrides or loaded
 * secrets in it. Each stack's own env reaches its panes through the launch command.
 */
function tmuxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (TMUX_ENV_NAMES.has(name) || name.startsWith("LC_")) env[name] = value;
  }
  env.PATH = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && !entry.split(path.sep).join("/").includes("node_modules/.bin"))
    .join(path.delimiter);
  return env;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export class TmuxSessionStore {
  constructor(private readonly repoRoot: string) {}

  hasCommandOnPath(command: string): boolean {
    const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      stdio: "ignore",
    });
    return result.status === 0;
  }

  run(command: string, args: string[]): CommandResult {
    return run(command, args, this.repoRoot, tmuxEnv());
  }

  private tmux(args: string[]): CommandResult {
    // Run from $HOME: a tmux server keeps its first client's cwd, and a checkout
    // that cleanup later removes would leave the shared server with a deleted one.
    return run("tmux", devTmuxArgs(args), os.homedir(), tmuxEnv());
  }

  sessionExists(sessionName: string): boolean {
    return this.tmux(["has-session", "-t", sessionName]).status === 0;
  }

  /** Read-only check for a stack an older `pnpm dev` started on the default server. */
  legacyDefaultServerHasSession(sessionName: string): boolean {
    return (
      this.run("tmux", legacyDefaultServerArgs(["has-session", "-t", `=${sessionName}`])).status ===
      0
    );
  }

  createSession(sessionName: string): CommandResult {
    return this.tmux(["new-session", "-d", "-s", sessionName, "-c", this.repoRoot]);
  }

  killSession(sessionName: string): CommandResult {
    return this.tmux(["kill-session", "-t", sessionName]);
  }

  sendKeys(sessionName: string, command: string): CommandResult {
    return this.tmux(["send-keys", "-t", `${sessionName}:0`, command, "C-m"]);
  }
}
