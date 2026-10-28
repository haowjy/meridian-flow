import { spawnSync } from "node:child_process";
import { devTmuxArgs, legacyDefaultServerArgs } from "./lib/dev-tmux-socket";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
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
  /**
   * `env` is what tmux and its helpers run with. `pnpm dev` passes its environment
   * from before the dev-env loader ran: a tmux server this call starts keeps that
   * environment as its global one, and every window opened on it later inherits it,
   * so the loaded secrets must never reach it. Panes get their env from the loader.
   */
  constructor(
    private readonly repoRoot: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  hasCommandOnPath(command: string): boolean {
    const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      stdio: "ignore",
    });
    return result.status === 0;
  }

  run(command: string, args: string[]): CommandResult {
    return run(command, args, this.repoRoot, this.env);
  }

  private tmux(args: string[]): CommandResult {
    return this.run("tmux", devTmuxArgs(args));
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
