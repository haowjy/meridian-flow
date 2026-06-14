import type { DevMode } from "./dev-mode";

export interface DevOutputContext {
  headline: string;
  sessionName: string;
  mode: DevMode;
  routeLines: string[];
}

function tmuxAttachCommand(sessionName: string): string {
  return `tmux attach -t ${sessionName}`;
}

export function printSessionInfo(context: DevOutputContext): void {
  console.log(`${context.headline} · ${context.mode} · ${context.sessionName}`);
  console.log(tmuxAttachCommand(context.sessionName));

  if (context.routeLines.length === 0) {
    console.log("urls pending — pnpm portless:list");
  } else {
    for (const line of context.routeLines) {
      console.log(line);
    }
  }

  console.log("pnpm portless:list · pnpm dev --restart");
}

export function printFailure({
  sessionName,
  message,
  remediation,
  routeLines = [],
}: {
  sessionName: string;
  message: string;
  remediation: string;
  logPath: string;
  routeLines?: string[];
}): void {
  console.error(`dev refused: ${message}`);

  if (routeLines.length > 0) {
    console.error("already serving at:");
    for (const line of routeLines) {
      console.error(line);
    }
  }

  console.error(tmuxAttachCommand(sessionName));
  console.error(`${remediation} · pnpm portless:list · pnpm dev --restart`);
}
