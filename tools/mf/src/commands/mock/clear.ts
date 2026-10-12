/** `mock clear`: drop one queued mock script, or all. */
import {
  API_DEBUG_MOCK_MODEL_SCRIPT_PATH,
  type MockModelScriptState,
} from "@meridian/contracts/protocol";
import { type CommandSpec, stringOption } from "../../core/command";
import { renderState } from "./queue";

export const mockClearCommand: CommandSpec = {
  path: ["mock", "clear"],
  summary: "Drop one queued mock script (--id), or all of them",
  route: "DELETE /api/debug/mock-model/script[?id=]",
  options: { id: { type: "string", description: "Script id from `./mf mock list`" } },
  examples: ["./mf mock clear", "./mf mock clear --id <scriptId>"],
  async run(ctx) {
    const id = stringOption(ctx, "id");
    const session = await ctx.session();
    ctx.out.result(
      await session.request<MockModelScriptState>(
        "DELETE",
        `${API_DEBUG_MOCK_MODEL_SCRIPT_PATH}${id ? `?id=${encodeURIComponent(id)}` : ""}`,
      ),
      renderState,
    );
    return undefined;
  },
};
