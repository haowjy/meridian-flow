/** Project lookup commands. */
import { API_PROJECTS_PATH, type ListProjectsResponse } from "@meridian/contracts/protocol";
import type { CommandSpec } from "../command";
import { resolveProjectId } from "../command";

export const projectListCommand: CommandSpec = {
  path: ["project", "list"],
  summary: "List projects",
  route: "GET /api/projects",
  examples: ["./mf project list", "./mf project list --json --fields id,title"],
  async run(ctx) {
    const session = await ctx.session();
    const { projects } = await session.request<ListProjectsResponse>("GET", API_PROJECTS_PATH);
    ctx.out.result(projects, (value) =>
      value.length === 0
        ? "(no projects)"
        : value.map((project) => `${project.id}  ${project.slug}  ${project.title}`).join("\n"),
    );
    return undefined;
  },
};

export const projectDefaultCommand: CommandSpec = {
  path: ["project", "default"],
  summary: "Ensure and print the default project id",
  route: "POST /api/projects/bootstrap-default",
  examples: ["./mf project default"],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, undefined);
    ctx.out.result({ projectId }, (value) => value.projectId);
    return undefined;
  },
};
