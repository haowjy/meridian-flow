/** Thread data commands: list, view, context (model requests), events (journal replay). */
import {
  API_THREADS_PATH,
  apiProjectThreadsPath,
  apiThreadModelRequestsDebugPath,
  apiThreadSnapshotPath,
  type ListThreadsResponse,
  type ModelRequestDebugListResponse,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import {
  deriveModelRequestDebugViews,
  type ModelRequestDebugView,
  renderModelRequestDebugMarkdown,
  summarizeModelRequestDebugView,
} from "@meridian/contracts/threads";
import { usageError } from "../cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  intOption,
  requirePositional,
  resolveProjectId,
  resolveThreadId,
  resolveWorkId,
  stringOption,
} from "../command";
import { followThread } from "../thread-stream";
import {
  projectThreadView,
  renderThreadList,
  renderThreadView,
  type ThreadListRow,
  threadListRow,
} from "../transcript";

export const threadListCommand: CommandSpec = {
  path: ["thread", "list"],
  summary: "List threads, newest activity first",
  route: "GET /api/threads | GET /api/projects/:projectId/threads",
  options: {
    project: { type: "string", description: "Project id, or `default`" },
    work: { type: "string", description: "Filter by Work: @slug, or @/ for No Work" },
    limit: { type: "string", description: "Max rows (default 20)" },
  },
  examples: ["./mf thread list", "./mf thread list --project default --work @/ --limit 5 --json"],
  async run(ctx) {
    const session = await ctx.session();
    const projectRaw = stringOption(ctx, "project");
    const workRaw = stringOption(ctx, "work");
    const limit = intOption(ctx, "limit", 20);
    let threads: ListThreadsResponse["threads"];
    let workId: string | null | undefined;
    if (projectRaw !== undefined || workRaw !== undefined) {
      const projectId = await resolveProjectId(session, projectRaw);
      ({ threads } = await session.request<ListThreadsResponse>(
        "GET",
        apiProjectThreadsPath(projectId),
      ));
      if (workRaw !== undefined) workId = await resolveWorkId(session, projectId, workRaw);
    } else {
      ({ threads } = await session.request<ListThreadsResponse>("GET", API_THREADS_PATH));
    }
    const rows: ThreadListRow[] = threads
      .filter((thread) => workId === undefined || thread.workId === workId)
      .map(threadListRow)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const shown = rows.slice(0, limit || rows.length);
    ctx.out.result(shown, (value) =>
      [
        renderThreadList(value),
        rows.length > value.length
          ? `(showing ${value.length} of ${rows.length}; --limit 0 for all)`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return undefined;
  },
};

export const threadViewCommand: CommandSpec = {
  path: ["thread", "view"],
  summary: "Transcript: turns, text, tool calls, status, usage",
  args: "<thread>",
  route: "GET /api/threads/:threadId/snapshot",
  options: {
    turn: { type: "string", description: "Only this turn (id or id prefix)" },
    last: { type: "string", description: "Show the last N turns (default 20)" },
    full: { type: "boolean", description: "No truncation, all turns" },
  },
  examples: [
    "./mf thread view 3f9a",
    "./mf thread view <id> --turn <turnId> --full",
    "./mf thread view <id> --json --fields turns",
  ],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(session, requirePositional(ctx, 0, "<thread>"));
    const snapshot = await session.request<ThreadSnapshotResponse>(
      "GET",
      apiThreadSnapshotPath(threadId),
    );
    const view = projectThreadView(snapshot, {
      full: flag(ctx, "full"),
      turnId: stringOption(ctx, "turn"),
      last: intOption(ctx, "last", 20),
    });
    ctx.out.result(view, renderThreadView);
    return undefined;
  },
};

type ContextView = "readable" | "raw" | "summary";

function formatContext(views: readonly ModelRequestDebugView[], kind: ContextView) {
  return views.map((view) => {
    const debug = summarizeModelRequestDebugView(view);
    if (kind === "raw") return { request: view.record.request, debug };
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
    const threadId = await resolveThreadId(session, requirePositional(ctx, 0, "<thread>"));
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

export const threadEventsCommand: CommandSpec = {
  path: ["thread", "events"],
  summary: "Replay the thread's journaled events (no live follow)",
  args: "<thread>",
  route: "WS /api/threads/ws subscribe {lastSeq} catch-up",
  options: {
    since: { type: "string", description: "Replay strictly after this seq (default 0)" },
    full: { type: "boolean", description: "Do not truncate tool payloads" },
    timeout: { type: "string", description: "Give up after this long (default 15s)" },
  },
  examples: ["./mf thread events <id>", "./mf thread events <id> --since 120 --json"],
  async run(ctx) {
    const since = stringOption(ctx, "since") ?? "0";
    if (!/^\d+$/.test(since)) throw usageError("--since must be a non-negative integer seq");
    const session = await ctx.session();
    const threadId = await resolveThreadId(session, requirePositional(ctx, 0, "<thread>"));
    const result = await followThread({
      session,
      threadId,
      lastSeq: since,
      deadlineAt: Date.now() + durationOption(ctx, "timeout", 15_000),
      out: ctx.out,
      full: flag(ctx, "full"),
      textStream: "out",
      catchupOnly: true,
    });
    ctx.out.note(
      `(caught up to seq ${result.lastSeq}; ./mf thread tail ${threadId} --since ${result.lastSeq} follows live)`,
    );
    return undefined;
  },
};
