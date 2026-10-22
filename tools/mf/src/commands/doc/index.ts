/** `doc`: read, seed, and delete project documents. */
import type { CommandGroup } from "../../core/command";
import { docPutCommand } from "./put";
import { docReadCommand } from "./read";
import { docRmCommand } from "./rm";

export const docGroup: CommandGroup = {
  name: "doc",
  summary: "Read, seed, and delete project documents",
  commands: [docReadCommand, docPutCommand, docRmCommand],
};
