import { compileGrep, type GrepQuery } from "../domains/context/index.js";
import type { FileDestination } from "../domains/file-policy/index.js";

export function grepQuery(
  pattern: string,
  options: { ignoreCase?: boolean; path?: string; destination?: FileDestination } = {},
): GrepQuery {
  const matcher = compileGrep(pattern, options.ignoreCase ?? false);
  if (!matcher.ok) throw new Error(matcher.error);
  return {
    matcher: matcher.value,
    ...(options.path ? { path: options.path } : {}),
    signal: AbortSignal.timeout(20_000),
    mode: "content",
    headLimit: 50,
    readable: async (ids) =>
      new Map(
        ids.map((id) => [
          id,
          { level: "edit" as const, destination: options.destination ?? { kind: "live" as const } },
        ]),
      ),
  };
}
