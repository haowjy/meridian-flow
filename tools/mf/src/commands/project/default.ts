import type { CommandSpec } from "../../core/command";
import { resolveProjectId } from "./resolve";

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
