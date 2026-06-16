import { spawnSync } from "node:child_process";

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
  constructor(private readonly repoRoot: string) {}

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

  sessionExists(sessionName: string): boolean {
    return this.run("tmux", ["has-session", "-t", sessionName]).status === 0;
  }

  createSession(sessionName: string): CommandResult {
    return this.run("tmux", ["new-session", "-d", "-s", sessionName, "-c", this.repoRoot]);
  }

  killSession(sessionName: string): CommandResult {
    return this.run("tmux", ["kill-session", "-t", sessionName]);
  }

  sendKeys(sessionName: string, command: string): CommandResult {
    return this.run("tmux", ["send-keys", "-t", `${sessionName}:0`, command, "C-m"]);
  }
}
