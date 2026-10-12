/** `api`: any authenticated request against the server API. */
import type { CommandGroup } from "../../core/command";
import { apiCommand } from "./api";

export const apiGroup: CommandGroup = {
  name: "api",
  summary: "Any authenticated API request",
  commands: [apiCommand],
};
