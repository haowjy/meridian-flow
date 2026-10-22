/** `seed`: one-shot scenario setup from a fixture. */
import type { CommandGroup } from "../../core/command";
import { seedCommand } from "./seed";

export const seedGroup: CommandGroup = {
  name: "seed",
  summary: "Set up a scenario from a fixture",
  commands: [seedCommand],
};
