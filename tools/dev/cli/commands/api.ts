/** `./mf api`: any authenticated request against this worktree's server (like `gh api`). */
import { usageError } from "../cli-error";
import { type CommandSpec, readJsonArg, requirePositional, stringOption } from "../command";
import type { HttpMethod } from "../session";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const apiCommand: CommandSpec = {
  path: ["api"],
  summary: "Send any authenticated request to the server API",
  args: "<METHOD> <path>",
  route: "any /api/* route",
  options: {
    data: { type: "string", description: "JSON body: literal, @file, or - for stdin" },
  },
  examples: [
    "./mf api GET /api/threads",
    "./mf api POST /api/projects/bootstrap-default",
    `./mf api PATCH /api/threads/<id>/title --data '{"title":"Chapter 3 notes"}'`,
  ],
  async run(ctx) {
    const method = requirePositional(ctx, 0, "<METHOD>").toUpperCase() as HttpMethod;
    if (!METHODS.has(method)) throw usageError(`Unsupported method ${method}`);
    const path = requirePositional(ctx, 1, "<path>");
    if (!path.startsWith("/")) throw usageError("<path> must start with /, e.g. /api/threads");
    const data = stringOption(ctx, "data");
    const session = await ctx.session();
    const body = data === undefined ? undefined : readJsonArg(data, "--data");
    const response = await session.request(method, path, body);
    ctx.out.result(response ?? null, (value) =>
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    return undefined;
  },
};
