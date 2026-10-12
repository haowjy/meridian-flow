/** `mock`: script the dev mock model (MODEL_PROVIDER=mock stacks only). */
import type { CommandGroup } from "../../core/command";
import { mockClearCommand } from "./clear";
import { mockListCommand } from "./list";
import { mockScriptCommand } from "./script";

export const mockGroup: CommandGroup = {
  name: "mock",
  summary: "Script the dev mock model",
  commands: [mockScriptCommand, mockListCommand, mockClearCommand],
};
