/** `log`: recent server observability records. */
import type { CommandGroup } from "../../core/command";
import { logCommand } from "./log";

export const logGroup: CommandGroup = {
  name: "log",
  summary: "Recent server events",
  commands: [logCommand],
};
