/** `mock list`: show queued mock scripts. */
import {
  API_DEBUG_MOCK_MODEL_SCRIPT_PATH,
  type MockModelScriptState,
} from "@meridian/contracts/protocol";
import type { CommandSpec } from "../../core/command";
import { renderState } from "./queue";

export const mockListCommand: CommandSpec = {
  path: ["mock", "list"],
  summary: "Show queued mock scripts",
  route: "GET /api/debug/mock-model/script",
  examples: ["./mf mock list"],
  async run(ctx) {
    const session = await ctx.session();
    ctx.out.result(
      await session.request<MockModelScriptState>("GET", API_DEBUG_MOCK_MODEL_SCRIPT_PATH),
      renderState,
    );
    return undefined;
  },
};
