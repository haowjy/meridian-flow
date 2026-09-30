/** Thread driving commands: create, send (wait by default), tail, cancel, respond. */
import { randomUUID } from "node:crypto";
import {
  apiThreadMessagePath,
  apiThreadSkillsPath,
  apiThreadSnapshotPath,
  type SendMessageRequest,
  type SendMessageResponse,
  type SubmittedReference,
  type ThreadAvailableSkillsResponse,
  type ThreadSnapshotResponse,
  type UserMessageBlock,
} from "@meridian/contracts/protocol";
import { blockPlainText, type Turn } from "@meridian/contracts/threads";
import { CliError, EXIT, type ExitCode, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  listOption,
  readJsonArg,
  readValueArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";
import { resolveDocumentId, resolveUri } from "../doc/uri";
import { enqueueMockScript, removeMockScript } from "../mock/queue";
import type { CliEvent } from "./events-map";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { followThread } from "./stream";

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
  // Text segments split by tool calls are separate replies, so they get a paragraph break.
  let text = "";
  let brokenByOtherBlock = false;
  for (const block of [...turn.blocks].sort((a, b) => a.sequence - b.sequence)) {
    if (block.blockType !== "text") {
      brokenByOtherBlock = true;
      continue;
    }
    const piece = blockPlainText(block.blockType, block.content) ?? block.textContent ?? "";
    if (!piece) continue;
    text = text && brokenByOtherBlock ? `${text.trimEnd()}\n\n${piece.trimStart()}` : text + piece;
    brokenByOtherBlock = false;
  }
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
  const mockScriptId =
    input.mock === undefined
      ? null
      : (await enqueueMockScript(session, input.mock, message.text)).id;
  const submissionId = randomUUID();
  try {
    const admitted = await session.request<SendMessageResponse>(
      "POST",
      apiThreadMessagePath(input.threadId),
      { submissionId, ...message } satisfies SendMessageRequest,
    );
    return { submissionId, admitted, mockScriptId };
  } catch (error) {
    if (mockScriptId) await removeMockScript(session, mockScriptId).catch(() => undefined);
    throw error;
  }
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
  const { admitted, mockScriptId } = await admitMessage(session, input);
  try {
    return await followToOutcome(session, out, input, admitted);
  } finally {
    // A scripted sticky error would otherwise keep failing later calls with the same text.
    if (mockScriptId) await removeMockScript(session, mockScriptId).catch(() => undefined);
  }
}

async function followToOutcome(
  session: Session,
  out: Output,
  input: SendInput,
  admitted: SendMessageResponse,
): Promise<SendOutcome> {
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
    ...THREAD_TARGET_OPTIONS,
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
    const threadId = await resolveThreadId(session, rawThread, stringOption(ctx, "project"));

    if (flag(ctx, "no-wait")) {
      const { submissionId, admitted, mockScriptId } = await admitMessage(session, {
        threadId,
        ...input,
      });
      ctx.out.result(
        {
          threadId,
          submissionId,
          userTurnId: admitted.userTurnId,
          assistantTurnId: admitted.assistantTurnId,
          resumeAfterSeq: admitted.resumeAfterSeq,
          // Nothing waits here to remove it; clear it with `./mf mock clear --id` when done.
          mockScriptId,
        },
        (value) =>
          [
            `accepted ${value.userTurnId} (./mf thread tail ${threadId} --since ${value.resumeAfterSeq})`,
            value.mockScriptId
              ? `mock script ${value.mockScriptId} stays queued (./mf mock clear --id ${value.mockScriptId})`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
      );
      return undefined;
    }
    return finish(ctx.out, await sendMessage(session, ctx.out, { threadId, ...input }));
  },
};
