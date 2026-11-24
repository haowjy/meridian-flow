export const DEV_TMUX_SOCKET = "meridian-flow-dev";

export function devTmuxArgs(args: readonly string[]): string[] {
  return ["-L", DEV_TMUX_SOCKET, ...args];
}

export function legacyDefaultServerArgs(args: readonly string[]): string[] {
  return ["-L", "default", ...args];
}
