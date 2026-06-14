export type DevMode = "local" | "tailscale" | "funnel";

interface ParseModeInput {
  argv: string[];
  env?: NodeJS.ProcessEnv;
}

export interface DevCliOptions {
  mode: DevMode;
  restart: boolean;
  print: boolean;
  preserveModeOnRestart: boolean;
  explicitModeFlag: boolean;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function parseDevCliOptions({ argv, env = process.env }: ParseModeInput): DevCliOptions {
  const wantsFunnel = argv.includes("--funnel") || isTruthy(env.PORTLESS_FUNNEL);
  const wantsTailscale =
    wantsFunnel || argv.includes("--tailscale") || isTruthy(env.PORTLESS_TAILSCALE);

  return {
    mode: wantsFunnel ? "funnel" : wantsTailscale ? "tailscale" : "local",
    restart: argv.includes("--restart"),
    print: argv.includes("--print") || env.DEV_TMUX_DRY === "1",
    preserveModeOnRestart: argv.includes("--preserve-mode"),
    explicitModeFlag: argv.includes("--tailscale") || argv.includes("--funnel"),
  };
}

export function applyModeEnv(mode: DevMode): void {
  if (mode === "funnel") {
    process.env.PORTLESS_TAILSCALE = "1";
    process.env.PORTLESS_FUNNEL = "1";
    return;
  }

  if (mode === "tailscale") {
    process.env.PORTLESS_TAILSCALE = "1";
    delete process.env.PORTLESS_FUNNEL;
    return;
  }

  delete process.env.PORTLESS_TAILSCALE;
  delete process.env.PORTLESS_FUNNEL;
}
