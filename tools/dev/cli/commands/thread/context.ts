/** `thread context`: the model requests the LLM actually received (dev capture). */
import {
  apiThreadModelRequestsDebugPath,
  type ModelRequestDebugListResponse,
} from "@meridian/contracts/protocol";
import {
  deriveModelRequestDebugViews,
  type ModelRequestDebugView,
  renderModelRequestDebugMarkdown,
  summarizeModelRequestDebugView,
} from "@meridian/contracts/threads";
import { usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  flag,
  intOption,
  requirePositional,
  stringOption,
} from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";

type ContextView = "readable" | "raw" | "summary";

function formatContext(views: readonly ModelRequestDebugView[], kind: ContextView) {
  return views.map((view) => {
    const debug = summarizeModelRequestDebugView(view);
    if (kind === "raw") {
      return { request: view.record.request, providerError: view.record.providerError, debug };
    }
    if (kind === "summary") return { debug };
    return { markdown: renderModelRequestDebugMarkdown(view), debug };
  });
}

export const threadContextCommand: CommandSpec = {
  path: ["thread", "context"],
  summary: "Model request(s) the LLM actually received (dev capture)",
  args: "<thread>",
  route: "GET /api/threads/:threadId/debug/model-requests",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Only requests for this turn" },
    iteration: { type: "string", description: "Only this loop iteration" },
    call: { type: "string", description: "Only this gateway call id" },
    all: { type: "boolean", description: "Every matching request, not just the latest" },
    view: { type: "string", description: "readable | raw | summary (default readable)" },
  },
  examples: ["./mf thread context <id>", "./mf thread context <id> --all --view summary --json"],
  async run(ctx) {
    const kind = (stringOption(ctx, "view") ?? "readable") as ContextView;
    if (!["readable", "raw", "summary"].includes(kind)) {
      throw usageError("--view must be readable, raw, or summary");
    }
    const iterationRaw = stringOption(ctx, "iteration");
    const iteration = iterationRaw === undefined ? undefined : intOption(ctx, "iteration", 0);
    const gatewayCallId = stringOption(ctx, "call");
    const all = flag(ctx, "all");
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const narrowed = all || iteration !== undefined || gatewayCallId !== undefined;
    const response = await session.request<ModelRequestDebugListResponse>(
      "GET",
      apiThreadModelRequestsDebugPath(threadId, {
        turnId: stringOption(ctx, "turn"),
        iteration,
        gatewayCallId,
        latest: !narrowed,
      }),
    );
    const views = deriveModelRequestDebugViews(response.records).filter(
      ({ record }) =>
        (iteration === undefined || record.iteration === iteration) &&
        (gatewayCallId === undefined || record.gatewayCallId === gatewayCallId),
    );
    const selected = narrowed ? views : views.slice(-1);
    const result = {
      threadId,
      matches: selected.length,
      retention: response.retention,
      requests: formatContext(selected, kind),
    };
    ctx.out.result(result, (value) => {
      if (value.matches === 0) {
        return "(no captured model requests; capture is dev-only and in-memory, see retention)";
      }
      return value.requests
        .map((request) =>
          "markdown" in request
            ? request.markdown
            : JSON.stringify("request" in request ? request : request.debug, null, 2),
        )
        .join("\n\n---\n\n");
    });
    return undefined;
  },
};
