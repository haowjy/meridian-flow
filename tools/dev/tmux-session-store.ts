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

// keep: the first tmux call starts the shared dev server and keeps its caller's environment for every later window from any checkout, so it is a fixed allowlist with no caller overrides or secrets
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

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function tmuxQuote(word: string): string {
  const escaped = word
    .replace(/[\\"$]/g, "\\$&")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
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

  private tmux(args: string[], input?: string): CommandResult {
    return run("tmux", devTmuxArgs(args), os.homedir(), tmuxEnv(), input);
  }

  sessionExists(sessionName: string): boolean {
    return this.tmux(["has-session", "-t", sessionName]).status === 0;
  }

  legacyDefaultServerHasSession(sessionName: string): boolean {
    return (
      this.run("tmux", legacyDefaultServerArgs(["has-session", "-t", `=${sessionName}`])).status ===
      0
    );
  }

  createSession(sessionName: string, env: Record<string, string>): CommandResult {
    const args = ["new-session", "-d", "-s", sessionName, "-c", this.repoRoot];
    for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
    return this.tmux(
      ["start-server", ";", "source-file", "-"],
      `${args.map(tmuxQuote).join(" ")}\n`,
    );
  }

  sessionEnv(sessionName: string): Record<string, string> | null {
    const result = this.tmux(["show-environment", "-s", "-t", `=${sessionName}`]);
    if (result.status !== 0) return null;
    const env: Record<string, string> = {};
    for (const [, key, quoted] of result.stdout.matchAll(
      /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"; export \1;$/gms,
    ))
      env[key] = quoted.replace(/\\(.)/gs, "$1");
    return env;
  }

  killSession(sessionName: string): CommandResult {
    return this.tmux(["kill-session", "-t", sessionName]);
  }

  sendKeys(sessionName: string, command: string): CommandResult {
    return this.tmux(["send-keys", "-t", `${sessionName}:0`, command, "C-m"]);
  }

  startWindow(sessionName: string, name: string, command: string): CommandResult {
    return this.tmux([
      "new-window",
      "-d",
      "-t",
      `${sessionName}:`,
      "-n",
      name,
      "-c",
      this.repoRoot,
      command,
    ]);
  }
}
