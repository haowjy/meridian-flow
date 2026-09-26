/** Thread driving commands: create, send (wait by default), tail, cancel, respond. */
import { randomUUID } from "node:crypto";
import type { AgentCatalogPage } from "@meridian/contracts/agents";
import {
  API_THREADS_PATH,
  apiThreadCancelPath,
  apiThreadMessagePath,
  apiThreadSkillsPath,
  apiThreadSnapshotPath,
  type CancelTurnResponse,
  type CreateThreadRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type SubmittedReference,
  type ThreadAvailableSkillsResponse,
  type ThreadSnapshotResponse,
  type UserMessageBlock,
} from "@meridian/contracts/protocol";
import { blockPlainText, type Thread, type Turn } from "@meridian/contracts/threads";
import { CliError, EXIT, type ExitCode, usageError } from "../cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  listOption,
  readJsonArg,
  readValueArg,
  requirePositional,
  resolveProjectId,
  resolveThreadId,
  resolveWorkId,
  stringOption,
} from "../command";
import { resolveDocumentId, resolveUri } from "../context-uri";
import type { Output } from "../output";
import type { CliEvent } from "../run-events";
import type { Session } from "../session";
import { openThreadSocket } from "../thread-socket";
import { followThread } from "../thread-stream";
import { enqueueMockScript } from "./mock";

const DEFAULT_AGENT_SLUG = "general";

async function resolveAgentSelection(session: Session, projectId: string, slug: string) {
  const page = await session.request<AgentCatalogPage>(
    "GET",
    `/api/agents?projectId=${encodeURIComponent(projectId)}&limit=100`,
  );
  const agent = page.agents.find((entry) => entry.slug === slug);
  if (!agent) {
    throw new CliError("not_found", `No agent with slug "${slug}"`, {
      hint: `Available: ${page.agents.map((entry) => entry.slug).join(", ")}`,
    });
  }
  if (agent.unavailableReasons.length > 0) {
    throw new CliError(
      "usage",
      `Agent "${slug}" is unavailable: ${agent.unavailableReasons.join(", ")}`,
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
    ...(input.title ? { title: input.title } : {}),
  };
  return session.request<Thread>("POST", API_THREADS_PATH, body);
}

export const threadCreateCommand: CommandSpec = {
  path: ["thread", "create"],
  summary: "Create a thread and print its id",
  route: "POST /api/threads",
  options: {
    project: { type: "string", description: "Project id, or `default` (default)" },
    agent: { type: "string", description: `Agent slug (default ${DEFAULT_AGENT_SLUG})` },
    work: { type: "string", description: "Bind to a Work: @slug, or @/ for No Work (default)" },
    title: { type: "string", description: "Thread title" },
  },
  examples: [
    "./mf thread create",
    "./mf thread create --work @draft-2 --title 'Arc 3 planning' --json",
  ],
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

export type ComposedMessage = Pick<
  SendMessageRequest,
  "text" | "blocks" | "references" | "activatedSkillSlugs"
>;

/** Mirrors the composer: skill chips first, then prose, then `@uri` reference chips. */
export function composeMessage(input: {
  text: string;
  skills: { slug: string; name: string; description: string }[];
  references: { documentId: string; uri: string }[];
}): ComposedMessage {
  const blocks: UserMessageBlock[] = [];
  for (const skill of input.skills) {
    blocks.push({ type: "skill", text: `/${skill.slug}`, ...skill });
    blocks.push({ type: "text", text: " " });
  }
  blocks.push({ type: "text", text: input.text });
  for (const reference of input.references) {
    blocks.push({ type: "text", text: " " });
    blocks.push({
      type: "reference",
      text: `@${reference.uri}`,
      documentId: reference.documentId as never,
      uri: reference.uri,
    });
  }
  const references: SubmittedReference[] = input.references.map((reference) => ({
    documentId: reference.documentId as never,
    uri: reference.uri,
    purpose: "reference",
  }));
  return {
    text: blocks.map((block) => ("text" in block ? block.text : "")).join(""),
    blocks,
    references,
    ...(input.skills.length
      ? { activatedSkillSlugs: input.skills.map((skill) => skill.slug) }
      : {}),
  };
}

export type SendOutcome = {
  type: "result" | "error";
  threadId: string;
  turnId: string | null;
  status: Turn["status"] | "timeout" | "unknown";
  finalText: string | null;
  error: string | null;
  interrupt?: { turnId: string; interruptId: string };
};

function assistantText(turn: Turn | undefined): string | null {
  if (!turn) return null;
  const text = [...turn.blocks]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((block) => block.blockType === "text")
    .map((block) => blockPlainText(block.blockType, block.content) ?? block.textContent ?? "")
    .join("");
  return text || null;
}

export function exitForOutcome(outcome: SendOutcome): ExitCode {
  if (outcome.interrupt) return EXIT.interrupt;
  switch (outcome.status) {
    case "complete":
      return EXIT.ok;
    case "cancelled":
      return EXIT.cancelled;
    case "timeout":
      return EXIT.timeout;
    default:
      return EXIT.failed;
  }
}

export type SendInput = {
  threadId: string;
  text: string;
  refs?: string[];
  skills?: string[];
  /** Parsed mock script; scoped to this send's text unless it names its own `match`. */
  mock?: unknown;
  timeoutMs: number;
  full: boolean;
};

async function resolveReferences(session: Session, threadId: string, refs: string[]) {
  if (!refs.length) return [];
  const snapshot = await session.request<ThreadSnapshotResponse>(
    "GET",
    apiThreadSnapshotPath(threadId),
  );
  const projectId = snapshot.thread.projectId;
  return Promise.all(
    refs.map(async (raw) => {
      const target = await resolveUri(session, projectId, raw);
      return { uri: target.uri, documentId: await resolveDocumentId(session, projectId, target) };
    }),
  );
}

async function resolveSkills(session: Session, threadId: string, slugs: string[]) {
  if (!slugs.length) return [];
  const available = await session.request<ThreadAvailableSkillsResponse>(
    "GET",
    apiThreadSkillsPath(threadId),
  );
  return slugs.map((slug) => {
    const skill = available.skills.find((entry) => entry.slug === slug);
    if (!skill) {
      throw new CliError("not_found", `Skill "${slug}" is not available on this thread`, {
        hint: `Available: ${available.skills.map((entry) => entry.slug).join(", ") || "(none)"}`,
      });
    }
    return { slug: skill.slug, name: skill.name, description: skill.description };
  });
}

/** Admits one message through the real send route. */
export async function admitMessage(session: Session, input: Omit<SendInput, "timeoutMs" | "full">) {
  const message = composeMessage({
    text: input.text,
    skills: await resolveSkills(session, input.threadId, input.skills ?? []),
    references: await resolveReferences(session, input.threadId, input.refs ?? []),
  });
  if (input.mock !== undefined) await enqueueMockScript(session, input.mock, message.text);
  const submissionId = randomUUID();
  const admitted = await session.request<SendMessageResponse>(
    "POST",
    apiThreadMessagePath(input.threadId),
    { submissionId, ...message } satisfies SendMessageRequest,
  );
  return { submissionId, admitted };
}

/**
 * Send and wait: admit, follow from `resumeAfterSeq` until this send's run
 * finishes, fails, or raises an interrupt, then read the durable outcome.
 */
export async function sendMessage(
  session: Session,
  out: Output,
  input: SendInput,
): Promise<SendOutcome> {
  const { admitted } = await admitMessage(session, input);
  const { threadId } = input;
  let ourTurn: string | null = admitted.assistantTurnId;
  let interrupt: SendOutcome["interrupt"];
  const isOurs = (turnId: string) => ourTurn === null || ourTurn === turnId;
  try {
    await followThread({
      session,
      threadId,
      lastSeq: admitted.resumeAfterSeq,
      deadlineAt: Date.now() + input.timeoutMs,
      out,
      full: input.full,
      textStream: "err",
      shouldStop(event: CliEvent) {
        if (event.type === "turn.started" && ourTurn === null) ourTurn = event.turnId;
        if (event.type === "turn.finished") return isOurs(event.turnId);
        if (event.type === "turn.failed") return ourTurn !== null;
        if (event.type === "interrupt.requested" && isOurs(event.turnId)) {
          interrupt = { turnId: event.turnId, interruptId: event.interruptId };
          return true;
        }
        return false;
      },
    });
  } catch (error) {
    if (error instanceof CliError && error.code === "timeout") {
      return {
        type: "error",
        threadId,
        turnId: ourTurn,
        status: "timeout",
        finalText: null,
        error: `Run did not finish within ${input.timeoutMs}ms`,
      };
    }
    throw error;
  }
  const snapshot = await session.request<ThreadSnapshotResponse>(
    "GET",
    apiThreadSnapshotPath(threadId),
  );
  const turn = snapshot.turns.find((candidate) => candidate.id === ourTurn);
  const status: SendOutcome["status"] = interrupt
    ? "waiting_interrupt"
    : (turn?.status ?? "unknown");
  return {
    type: status === "complete" ? "result" : "error",
    threadId,
    turnId: ourTurn,
    status,
    finalText: assistantText(turn),
    error: turn?.error ?? null,
    ...(interrupt ? { interrupt } : {}),
  };
}

/** Writes the terminal envelope (always the last NDJSON line) and returns the exit code. */
function finish(out: Output, outcome: SendOutcome): ExitCode {
  out.record(outcome, null, "err");
  if (!out.json) {
    if (outcome.finalText) out.text(outcome.finalText.trim());
    out.note(
      outcome.interrupt
        ? `waiting on interrupt ${outcome.interrupt.interruptId}: ./mf thread respond ${outcome.threadId} --turn ${outcome.interrupt.turnId} --interrupt ${outcome.interrupt.interruptId} --value '<json>'`
        : `turn ${outcome.turnId ?? "?"} ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`,
    );
  }
  return exitForOutcome(outcome);
}

export const threadSendCommand: CommandSpec = {
  path: ["thread", "send"],
  summary: "Send a message and wait for the run to finish (exit code = outcome)",
  args: "<thread> <text>",
  route: "POST /api/threads/:threadId/messages + WS subscribe",
  options: {
    ref: { type: "string", multiple: true, description: "Attach a document reference (URI)" },
    skill: { type: "string", multiple: true, description: "Activate a skill by slug" },
    mock: {
      type: "string",
      description: "Script the mock model's replies for this send (JSON, @file, or -)",
    },
    "no-wait": { type: "boolean", description: "Return right after admission" },
    timeout: { type: "string", description: "Max wait (default 5m)" },
    full: { type: "boolean", description: "Do not truncate tool payloads in progress lines" },
  },
  examples: [
    `./mf thread send <id> "Summarize chapter 2"`,
    `./mf thread send <id> "Tighten this" --ref manuscript://chapter-2.md`,
    `./mf thread send <id> "go" --mock @tools/dev/cli/fixtures/mock-write.json --json | tail -1`,
  ],
  async run(ctx) {
    const rawThread = requirePositional(ctx, 0, "<thread>");
    const text = readValueArg(requirePositional(ctx, 1, "<text>"));
    if (!text.trim()) throw usageError("<text> is empty");
    const mockRaw = stringOption(ctx, "mock");
    const input = {
      text,
      refs: listOption(ctx, "ref"),
      skills: listOption(ctx, "skill"),
      ...(mockRaw !== undefined ? { mock: readJsonArg(mockRaw, "--mock") } : {}),
      timeoutMs: durationOption(ctx, "timeout", 5 * 60_000),
      full: flag(ctx, "full"),
    };
    const session = await ctx.session();
    const threadId = await resolveThreadId(session, rawThread);

    if (flag(ctx, "no-wait")) {
      const { submissionId, admitted } = await admitMessage(session, { threadId, ...input });
      ctx.out.result(
        {
          threadId,
          submissionId,
          userTurnId: admitted.userTurnId,
          assistantTurnId: admitted.assistantTurnId,
          resumeAfterSeq: admitted.resumeAfterSeq,
        },
        (value) =>
          `accepted ${value.userTurnId} (./mf thread tail ${threadId} --since ${value.resumeAfterSeq})`,
      );
      return undefined;
    }
    return finish(ctx.out, await sendMessage(session, ctx.out, { threadId, ...input }));
  },
};

export const threadTailCommand: CommandSpec = {
  path: ["thread", "tail"],
  summary: "Follow live events (catch-up first)",
  args: "<thread>",
  route: "WS /api/threads/ws subscribe",
  options: {
    since: { type: "string", description: "Replay strictly after this seq (default: live only)" },
    "until-idle": { type: "boolean", description: "Stop after the next run finishes or fails" },
    timeout: { type: "string", description: "Stop after this long (default 10m)" },
    full: { type: "boolean", description: "Do not truncate tool payloads" },
  },
  examples: ["./mf thread tail <id>", "./mf thread tail <id> --until-idle --json"],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(session, requirePositional(ctx, 0, "<thread>"));
    let since = stringOption(ctx, "since");
    if (since !== undefined && !/^\d+$/.test(since)) throw usageError("--since must be a seq");
    if (since === undefined) {
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      since = snapshot.liveState.resumeAfterSeq;
    }
    const untilIdle = flag(ctx, "until-idle");
    try {
      const result = await followThread({
        session,
        threadId,
        lastSeq: since,
        deadlineAt: Date.now() + durationOption(ctx, "timeout", 10 * 60_000),
        out: ctx.out,
        full: flag(ctx, "full"),
        textStream: "out",
        shouldStop: (event) =>
          untilIdle && (event.type === "turn.finished" || event.type === "turn.failed"),
      });
      return result.stoppedBy?.type === "turn.failed" ? EXIT.failed : undefined;
    } catch (error) {
      // A bounded tail that simply ran out of time is a normal stop, not a failure.
      if (error instanceof CliError && error.code === "timeout" && !untilIdle) return undefined;
      throw error;
    }
  },
};

export const threadCancelCommand: CommandSpec = {
  path: ["thread", "cancel"],
  summary: "Cancel the running turn (or a given turn)",
  args: "<thread>",
  route: "POST /api/threads/:threadId/turns/:turnId/cancel",
  options: { turn: { type: "string", description: "Turn id (default: the running turn)" } },
  examples: ["./mf thread cancel <id>"],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(session, requirePositional(ctx, 0, "<thread>"));
    let turnId = stringOption(ctx, "turn");
    if (!turnId) {
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      turnId = snapshot.liveState.runningTurnId ?? undefined;
      if (!turnId) throw new CliError("not_found", "Thread has no running turn");
    }
    const response = await session.request<CancelTurnResponse>(
      "POST",
      apiThreadCancelPath(threadId, turnId),
    );
    ctx.out.result(response, (value) => `${value.turnId} ${value.status}`);
    return response.status === "not_found" ? EXIT.notFound : undefined;
  },
};

export const threadRespondCommand: CommandSpec = {
  path: ["thread", "respond"],
  summary: "Answer a pending interrupt",
  args: "<thread>",
  route: "WS /api/threads/ws interrupt.respond",
  options: {
    turn: { type: "string", description: "Turn id that raised the interrupt" },
    interrupt: { type: "string", description: "Interrupt id" },
    value: { type: "string", description: "Answer as JSON (literal, @file, or -)" },
  },
  examples: [
    `./mf thread respond <id> --turn <turnId> --interrupt <interruptId> --value '{"choice":"a"}'`,
  ],
  async run(ctx) {
    const turnId = stringOption(ctx, "turn");
    const interruptId = stringOption(ctx, "interrupt");
    const rawValue = stringOption(ctx, "value");
    if (!turnId || !interruptId || rawValue === undefined) {
      throw usageError("--turn, --interrupt and --value are required");
    }
    const value = readJsonArg(rawValue, "--value");
    const session = await ctx.session();
    const threadId = await resolveThreadId(session, requirePositional(ctx, 0, "<thread>"));
    const socket = await openThreadSocket(session);
    try {
      socket.send({ type: "interrupt.respond", threadId, turnId, interruptId, value });
      // The socket reports failures as error frames; give it a moment to object.
      const deadline = Date.now() + 1_500;
      for (;;) {
        const message = await socket.next(deadline).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "timeout") return null;
          throw error;
        });
        if (!message) break;
        if (message.type === "error") {
          throw new CliError(
            "http_error",
            `Interrupt response rejected: ${message.error.message}`,
            {
              details: message.error,
            },
          );
        }
      }
    } finally {
      socket.close();
    }
    ctx.out.result(
      { threadId, turnId, interruptId, status: "sent" },
      () => `sent (./mf thread tail ${threadId} --until-idle to watch the run resume)`,
    );
    return undefined;
  },
};
