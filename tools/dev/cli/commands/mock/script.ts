import { type CommandSpec, readJsonArg, requirePositional, stringOption } from "../../core/command";
import { enqueueMockScript, renderState } from "./queue";

export const mockScriptCommand: CommandSpec = {
  path: ["mock", "script"],
  summary: "Queue scripted mock-model replies (one step per model call)",
  args: "<script>",
  route: "POST /api/debug/mock-model/script",
  options: {
    match: { type: "string", description: "Only calls whose latest user message contains this" },
  },
  examples: [
    `./mf mock script '[{"text":"Done."}]'`,
    "./mf mock script @tools/dev/cli/fixtures/mock-write.json --match 'draft the scene'",
  ],
  async run(ctx) {
    const raw = readJsonArg(requirePositional(ctx, 0, "<script>"), "<script>");
    const match = stringOption(ctx, "match");
    const withMatch =
      match === undefined
        ? raw
        : Array.isArray(raw)
          ? { match, steps: raw }
          : { ...(raw as object), match };
    const session = await ctx.session();
    ctx.out.result(await enqueueMockScript(session, withMatch), renderState);
    return undefined;
  },
};
