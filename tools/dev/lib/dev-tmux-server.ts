import os from "node:os";

/**
 * The one private tmux server that dev tooling may create or kill sessions on.
 *
 * The default server holds the machine owner's interactive sessions; a crash
 * there drops every attached shell, so dev stacks never start on it.
 */
export const DEV_TMUX_SERVER = "meridian-dev";

/**
 * Where dev tmux clients run. A client that starts the server hands it this cwd,
 * and the server outlives worktrees, so it must not be a checkout that cleanup
 * can remove.
 */
export const DEV_TMUX_CLIENT_CWD = os.homedir();

/**
 * tmux's built-in default socket name. Dev tooling only reads it, to stop
 * stacks started before the move and to find shells parked in a worktree.
 */
export const DEFAULT_TMUX_SERVER = "default";

export function devTmuxArgs(args: readonly string[]): string[] {
  return ["-L", DEV_TMUX_SERVER, ...args];
}

/** Human-facing command line for an invocation of the dev server. */
export function devTmuxCommand(args: readonly string[]): string {
  return ["tmux", ...devTmuxArgs(args)].join(" ");
}
