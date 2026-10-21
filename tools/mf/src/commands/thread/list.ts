/** `thread list`: threads, newest activity first. */
import {
  API_THREADS_PATH,
  apiProjectThreadsPath,
  type ListThreadsResponse,
  listThreadsResponseSchema,
} from "@meridian/contracts/protocol";
import { type CommandSpec, intOption, stringOption } from "../../core/command";
import { jsonResponse } from "../../core/session";
import { resolveProjectId, resolveWorkId } from "../project/resolve";
import { renderThreadList, type ThreadListRow, threadListRow } from "./transcript";

export const threadListCommand: CommandSpec = {
  path: ["thread", "list"],
  summary: "List threads, newest activity first",
  route: "GET /api/threads | GET /api/projects/:projectId/threads",
  options: {
    project: { type: "string", description: "Project id, or `default`" },
    work: { type: "string", description: "Filter by Work handle, such as w3; omit for all" },
    limit: { type: "string", description: "Max rows (default 20)" },
  },
  examples: ["./mf thread list", "./mf thread list --project default --work w3 --limit 5 --json"],
  async run(ctx) {
    const session = await ctx.session();
    const projectRaw = stringOption(ctx, "project");
    const workRaw = stringOption(ctx, "work");
    const limit = intOption(ctx, "limit", 20);
    let threads: ListThreadsResponse["threads"];
    let workId: string | null | undefined;
    if (projectRaw !== undefined || workRaw !== undefined) {
      const projectId = await resolveProjectId(session, projectRaw);
      ({ threads } = await session.request("GET", apiProjectThreadsPath(projectId), undefined, {
        decode: jsonResponse(listThreadsResponseSchema),
      }));
      if (workRaw !== undefined) workId = await resolveWorkId(session, projectId, workRaw);
    } else {
      ({ threads } = await session.request("GET", API_THREADS_PATH, undefined, {
        decode: jsonResponse(listThreadsResponseSchema),
      }));
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
