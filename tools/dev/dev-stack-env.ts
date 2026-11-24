const WITHHELD_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "PATH",
  "DATABASE_URL",
  "PORT",
  "INIT_CWD",
  "NODE",
  "NODE_PATH",
]);

const WITHHELD_PREFIXES = ["npm_", "PNPM_", "NX_"];

function isWithheld(key: string): boolean {
  return WITHHELD_KEYS.has(key) || WITHHELD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function resolveStackEnv(
  callerEnv: NodeJS.ProcessEnv,
  computed: Record<string, string | undefined>,
): Record<string, string> {
  const merged: NodeJS.ProcessEnv = { ...callerEnv, ...computed };
  const stackEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && !isWithheld(key)) stackEnv[key] = value;
  }
  return stackEnv;
}
