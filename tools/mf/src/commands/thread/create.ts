/** `thread create`: create a thread with a resolved agent selection; `createThread` is reused by seed. */
import { randomUUID } from "node:crypto";
import { agentCatalogSchema } from "@meridian/contracts/agents";
import { API_THREADS_PATH, type CreateThreadRequest } from "@meridian/contracts/protocol";
import { NO_OVERRIDES, type Thread, threadSchema } from "@meridian/contracts/threads";
import { CliError } from "../../core/cli-error";
import { type CommandSpec, stringOption } from "../../core/command";
import type { Session } from "../../core/session";
import { jsonResponse } from "../../core/session";
import { resolveProjectId, resolveWorkId } from "../project/resolve";

const DEFAULT_AGENT_SLUG = "general";

async function resolveAgentSelection(session: Session, projectId: string, slug: string) {
  const catalog = await session.request(
    "GET",
    `/api/agents?projectId=${encodeURIComponent(projectId)}`,
    undefined,
    { decode: jsonResponse(agentCatalogSchema) },
  );
  const agent = catalog.agents.find((entry) => entry.slug === slug);
  if (!agent) {
    throw new CliError("not_found", `No agent with slug "${slug}"`, {
      hint: `Available: ${catalog.agents.map((entry) => entry.slug).join(", ")}`,
    });
  }
  if (!agent.selection || agent.unavailableReasons.length > 0) {
    throw new CliError(
      "usage",
      `Agent "${slug}" is unavailable: ${agent.unavailableReasons.join(", ") || "nothing to pick"}`,
    );
  }
  return agent.selection;
}

export async function createThread(
  session: Session,
  input: { project?: string; agent?: string; work?: string; title?: string },
): Promise<Thread> {
  const projectId = await resolveProjectId(session, input.project);
  const body: CreateThreadRequest = {
    id: randomUUID(),
    projectId,
    agentSelection: await resolveAgentSelection(
      session,
      projectId,
      input.agent ?? DEFAULT_AGENT_SLUG,
    ),
    workId: await resolveWorkId(session, projectId, input.work),
    overrides: NO_OVERRIDES,
    ...(input.title ? { title: input.title } : {}),
  };
  return session.request("POST", API_THREADS_PATH, body, { decode: jsonResponse(threadSchema) });
}

export const threadCreateCommand: CommandSpec = {
  path: ["thread", "create"],
  summary: "Create a thread and print its id",
  route: "POST /api/threads",
  options: {
    project: { type: "string", description: "Project id, or `default` (default)" },
    agent: { type: "string", description: `Agent slug (default ${DEFAULT_AGENT_SLUG})` },
    work: { type: "string", description: "Bind to a Work by handle, such as w3; omit for No Work" },
    title: { type: "string", description: "Thread title" },
  },
  examples: ["./mf thread create", "./mf thread create --work w2 --title 'Arc 3 planning' --json"],
  async run(ctx) {
    const session = await ctx.session();
    const thread = await createThread(session, {
      project: stringOption(ctx, "project"),
      agent: stringOption(ctx, "agent"),
      work: stringOption(ctx, "work"),
      title: stringOption(ctx, "title"),
    });
    ctx.out.result(
      { threadId: thread.id, ref: thread.ref, projectId: thread.projectId, workId: thread.workId },
      (value) => `${value.threadId}\n(next: ./mf thread send ${value.threadId} "...")`,
    );
    return undefined;
  },
};
