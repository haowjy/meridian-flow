/** `doc`: read, seed, copy, and delete project documents. */
import type { CommandGroup } from "../../core/command";
import { docCopyCommand } from "./copy";
import { docEditCommand } from "./edit";
import { docPutCommand } from "./put";
import { docReadCommand } from "./read";
import { docRmCommand } from "./rm";

export const docGroup: CommandGroup = {
  name: "doc",
  summary: "Read, seed, edit, and delete project documents",
  commands: [docReadCommand, docPutCommand, docEditCommand, docCopyCommand, docRmCommand],
};
