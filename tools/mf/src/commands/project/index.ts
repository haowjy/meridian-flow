/** `project`: find projects. */
import type { CommandGroup } from "../../core/command";
import { projectDefaultCommand } from "./default";
import { projectListCommand } from "./list";

export const projectGroup: CommandGroup = {
  name: "project",
  summary: "Find projects",
  commands: [projectListCommand, projectDefaultCommand],
};
