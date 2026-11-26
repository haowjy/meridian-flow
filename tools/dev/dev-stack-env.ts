const WITHHELD_KEYS = new Set(["DATABASE_URL", "PORT", "INIT_CWD"]);
const WITHHELD_PREFIXES = ["npm_", "NX_"];

export function resolveStackEnv(callerEnv: NodeJS.ProcessEnv): Record<string, string> {
  const stackEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerEnv)) {
    if (value === undefined || WITHHELD_KEYS.has(key)) continue;
    if (WITHHELD_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    stackEnv[key] = value;
  }
  return stackEnv;
}
