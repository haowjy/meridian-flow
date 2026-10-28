/**
 * The private tmux socket every `pnpm dev` session lives on, shared by all
 * checkouts so `dev:stacks` and the orphan sweep see them all. Keeping dev
 * stacks off the default server means no dev command can reach the human's own
 * sessions. Any tmux call that manages a dev session builds its argv here.
 */
export const DEV_TMUX_SOCKET = "meridian-flow-dev";

export function devTmuxArgs(args: readonly string[]): string[] {
  return ["-L", DEV_TMUX_SOCKET, ...args];
}

/**
 * Stacks started before the private socket live on the default server, which
 * `-L default` names explicitly (it ignores `$TMUX`). Only ever used read-only.
 * TODO(remove): delete with `legacyDefaultServerHasSession` once no old stacks run.
 */
export function legacyDefaultServerArgs(args: readonly string[]): string[] {
  return ["-L", "default", ...args];
}
