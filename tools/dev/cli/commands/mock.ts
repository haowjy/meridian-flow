/** `./mf mock`: script what the dev mock model answers next (MODEL_PROVIDER=mock stacks only). */
import {
  API_DEBUG_MOCK_MODEL_SCRIPT_PATH,
  type MockModelScript,
  type MockModelScriptEnqueued,
  type MockModelScriptState,
  parseMockModelScript,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../cli-error";
import { type CommandSpec, readJsonArg, requirePositional, stringOption } from "../command";
import type { Session } from "../session";

const MOCK_HINT =
  "Scripting needs the in-process mock model: start the stack with MODEL_PROVIDER=mock (or no provider keys).";

/** Queues a script; `defaultMatch` scopes it to the send that follows. */
export async function enqueueMockScript(
  session: Session,
  raw: unknown,
  defaultMatch?: string,
): Promise<MockModelScriptEnqueued> {
  const parsed = parseMockModelScript(raw);
  if (!parsed.ok) throw usageError(`Invalid mock script: ${parsed.error}`);
  const script: MockModelScript = {
    ...parsed.value,
    ...(parsed.value.match === undefined && defaultMatch ? { match: defaultMatch } : {}),
  };
  try {
    return await session.request<MockModelScriptEnqueued>(
      "POST",
      API_DEBUG_MOCK_MODEL_SCRIPT_PATH,
      script,
    );
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") {
      throw new CliError("unavailable", "The server has no scriptable mock model", {
        hint: MOCK_HINT,
      });
    }
    throw error;
  }
}

function renderState(state: MockModelScriptState): string {
  if (state.scripts.length === 0) return "(no queued mock scripts)";
  return state.scripts
    .map(
      (script) =>
        `${script.id}  remaining=${script.remaining}${script.sticky ? " (sticky error)" : ""}  match=${script.match ?? "(any)"}`,
    )
    .join("\n");
}

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

/** Removes one queued script (e.g. the one a finished send queued). */
export async function removeMockScript(session: Session, id: string): Promise<void> {
  await session.request(
    "DELETE",
    `${API_DEBUG_MOCK_MODEL_SCRIPT_PATH}?id=${encodeURIComponent(id)}`,
  );
}

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
