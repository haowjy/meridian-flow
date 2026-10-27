import { spawnSync } from "node:child_process";
import { DEV_TMUX_CLIENT_CWD, DEV_TMUX_SERVER } from "./lib/dev-tmux-server";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
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
  /** `server` names an explicit socket; only teardown targets the default one. */
  constructor(
    private readonly repoRoot: string,
    private readonly server: string = DEV_TMUX_SERVER,
  ) {}

  hasCommandOnPath(command: string): boolean {
    const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      stdio: "ignore",
    });
    return result.status === 0;
  }

  run(command: string, args: string[]): CommandResult {
    return run(command, args, this.repoRoot);
  }

  private tmux(args: string[]): CommandResult {
    return run("tmux", ["-L", this.server, ...args], DEV_TMUX_CLIENT_CWD);
  }

  sessionExists(sessionName: string): boolean {
    return this.tmux(["has-session", "-t", sessionName]).status === 0;
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
