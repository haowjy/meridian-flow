/**
 * The environment `pnpm dev` hands to a new stack: what the caller's shell set,
 * plus the keys the plan computes. It goes to tmux as `new-session -e`, so a
 * variable the shell sets beats `.env` for the services exactly as it does for
 * `with-dev-env.ts` run directly.
 */

/** Keys the caller's shell must not hand to the stack, by reason. */
const WITHHELD_KEYS = new Set([
  // tmux's own: a stack launched from inside another pane would inherit that pane's server.
  "TMUX",
  "TMUX_PANE",
  // Per-process shell state, stale in a pane that is a different shell.
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  // The tmux server's PATH, which the store strips of `node_modules/.bin`, applies instead.
  "PATH",
  // Derived per checkout: `with-dev-env.ts` computes them, and a value left over
  // from another checkout or branch would point this stack at the wrong one.
  "DATABASE_URL",
  "PORT",
  // Set by the `pnpm dev` run itself, not by the person who ran it.
  "INIT_CWD",
  "NODE",
  "NODE_PATH",
]);

/** Prefixes of variables the package manager and Nx set for the `pnpm dev` run. */
const WITHHELD_PREFIXES = ["npm_", "PNPM_", "NX_"];

function isWithheld(key: string): boolean {
  return WITHHELD_KEYS.has(key) || WITHHELD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The caller's environment minus `WITHHELD_KEYS`, with `computed` laid over it (an `undefined` value drops the key). */
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
