/** A grep query for tests: one literal-or-regex pattern, every document readable. */
import { compileGrep, type GrepQuery } from "../domains/context/index.js";

export function grepQuery(
  pattern: string,
  options: { ignoreCase?: boolean; path?: string } = {},
): GrepQuery {
  const matcher = compileGrep(pattern, options.ignoreCase ?? false);
  if (!matcher.ok) throw new Error(matcher.error);
  return {
    matcher: matcher.value,
    ...(options.path ? { path: options.path } : {}),
    signal: AbortSignal.timeout(20_000),
    mode: "content",
    headLimit: 50,
    readable: async (ids) => new Map(ids.map((id) => [id, "edit" as const])),
  };
}
