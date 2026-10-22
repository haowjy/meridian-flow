/** Project lookup commands. */
import { API_PROJECTS_PATH, type ListProjectsResponse } from "@meridian/contracts/protocol";
import type { CommandSpec } from "../../core/command";
import { unknownJsonResponse } from "../../core/session";

export const projectListCommand: CommandSpec = {
  path: ["project", "list"],
  summary: "List projects",
  route: "GET /api/projects",
  examples: ["./mf project list", "./mf project list --json --fields id,title"],
  async run(ctx) {
    const session = await ctx.session();
    const { projects } = (await session.request("GET", API_PROJECTS_PATH, undefined, {
      decode: unknownJsonResponse,
    })) as ListProjectsResponse;
    ctx.out.result(projects, (value) =>
      value.length === 0
        ? "(no projects)"
        : value.map((project) => `${project.id}  ${project.slug}  ${project.title}`).join("\n"),
    );
    return undefined;
  },
};
