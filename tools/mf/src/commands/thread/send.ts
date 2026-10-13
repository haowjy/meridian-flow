/** Thread driving commands: create, send (wait by default), tail, cancel, respond. */
import { randomUUID } from "node:crypto";
import {
  type AdmissionLookup,
  apiThreadAdmissionPath,
  apiThreadMessagePath,
  apiThreadSkillsPath,
  apiThreadSnapshotPath,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadAvailableSkillsResponse,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import type { Turn } from "@meridian/contracts/threads";
import { buildMessageDoc, imageCapable, serializeMessageDoc } from "@meridian/thread-client";
import { CliError, usageError } from "../../core/cli-error";
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
import { resolveDocument, resolveUri } from "../doc/uri";
import { enqueueMockScript, removeMockScript } from "../mock/queue";
import type { CliEvent } from "./events-map";
import { type LiveDiff, ReducedThread } from "./reduced-thread";
import { replyText } from "./reply-text";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import {
  type Claim,
  finishResult,
  snapshotActivity,
  type TerminalResult,
  terminalResult,
  timeoutReport,
} from "./result";
import { followThread } from "./stream";
import { createThreadClient } from "./transport";

export type SendFields = {
  submissionId?: string;
  threadId: string;
  turnId: string | null;
  status: Turn["status"] | "timeout" | "unknown" | "blocked";
  finalText: string | null;
  error: string | null;
  interrupt?: { turnId: string; interruptId: string };
  /** This CLI follower's reduced status and text against the stored turn (`reduced-thread.ts`); absent when nothing was followed. */
  liveView?: "matches" | "differs" | "not_observed";
  liveDiff?: LiveDiff[];
};

export type SendOutcome = TerminalResult<SendFields>;

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
      const document = await resolveDocument(session, projectId, target);
      return {
        uri: target.uri,
        documentId: document.documentId,
        label: document.entry.name,
        imageCapable: imageCapable(document.entry.fileType),
      };
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
  const skills = await resolveSkills(session, input.threadId, input.skills ?? []);
  const references = await resolveReferences(session, input.threadId, input.refs ?? []);
  const message = serializeMessageDoc(buildMessageDoc({ skills, text: input.text, references }));
  const mockScriptId =
    input.mock === undefined
      ? null
      : (await enqueueMockScript(session, input.mock, message.text)).id;
  const submissionId = randomUUID();
  try {
    let admitted: SendMessageResponse;
    try {
      admitted = await session.request<SendMessageResponse>(
        "POST",
        apiThreadMessagePath(input.threadId),
        {
          submissionId,
          ...message,
          references: [...message.references],
          activatedSkillSlugs: [...message.activatedSkillSlugs],
        } satisfies SendMessageRequest,
      );
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.httpStatus !== undefined ||
        !["unavailable", "timeout"].includes(error.code)
      )
        throw error;
      let lookup: AdmissionLookup;
      try {
        lookup = await session.request<AdmissionLookup>(
          "GET",
          apiThreadAdmissionPath(input.threadId, submissionId),
        );
      } catch {
        throw new CliError("unproven", "Admission lookup failed", {
          details: { submissionId, reason: "admission_unknown" },
        });
      }
      if (lookup.kind === "accepted" || lookup.kind === "already-accepted") {
        admitted = { ...lookup, status: "accepted" };
      } else if (lookup.kind === "pending") {
        throw new CliError("unproven", "Admission is still pending", {
          details: { submissionId, reason: "admission_unknown" },
        });
      } else {
        throw new CliError("http_error", `Admission ${lookup.kind}`, { details: { submissionId } });
      }
    }
    return { submissionId, admitted, mockScriptId };
  } catch (error) {
    if (mockScriptId) await removeMockScript(session, mockScriptId).catch(() => undefined);
    throw error;
  }
}

/** Admission uncertainty is a claim result, not a successful send or an app failure. */
function admissionFailure(error: unknown, threadId: string): SendOutcome {
  if (!(error instanceof CliError) || !["unproven", "http_error"].includes(error.code)) throw error;
  return terminalResult(
    "thread.send",
    error.code === "unproven"
      ? { outcome: "unproven", reason: "admission_unknown" }
      : { outcome: "failed", reason: null },
    {
      threadId,
      turnId: null,
      status: "unknown",
      finalText: null,
      error: error.message,
      submissionId: (error.details as { submissionId?: string } | undefined)?.submissionId,
    },
  );
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
  let admission: Awaited<ReturnType<typeof admitMessage>>;
  try {
    admission = await admitMessage(session, input);
  } catch (error) {
    return admissionFailure(error, input.threadId);
  }
  const { admitted, mockScriptId } = admission;
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
  let lastSeq = admitted.resumeAfterSeq;
  let truncated = false;
  let interrupt: SendFields["interrupt"];
  // A usage block is proven only for this send's own accepted message: its
  // inbox id is the admitted user turn id.
  const blockedOutcome = (
    pending: ThreadSnapshotResponse["liveState"]["pending"],
  ): SendOutcome | null =>
    pending.blocked?.reason === "credits_exhausted" &&
    pending.items.some((item) => item.id === admitted.userTurnId)
      ? terminalResult(
          "thread.send",
          { outcome: "failed", reason: "credits_exhausted" },
          {
            threadId,
            turnId: null,
            status: "blocked",
            finalText: null,
            error: "Your message is waiting for usage",
          },
        )
      : null;
  let blocked: SendOutcome | null = null;
  // The shared reducer follows the same events the log prints, from admission's
  // cursor. There is deliberately no snapshot read here: this send's turns are
  // built from their own events, and a read would sit outside the deadline. A
  // usage block arrives as a replayed `meridian.inbox.changed` event, which
  // `shouldStop` below reconciles with the durable snapshot.
  const reduced = new ReducedThread(threadId);
  const transport = createThreadClient(session);
  const isOurs = (turnId: string) => ourTurn === null || ourTurn === turnId;
  try {
    const deadlineAt = Date.now() + input.timeoutMs;
    for (;;) {
      const followed = await followThread({
        session,
        transport,
        threadId,
        lastSeq,
        deadlineAt,
        out,
        full: input.full,
        textStream: "err",
        reduced,
        shouldStop(event: CliEvent) {
          if (event.type === "event" && event.name === "meridian.inbox.changed") {
            const pending = event.value as
              | ThreadSnapshotResponse["liveState"]["pending"]
              | undefined;
            if (pending) blocked = blockedOutcome(pending);
            if (blocked) return true;
          }
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
      lastSeq = followed.lastSeq;
      truncated ||= followed.truncated;
      if (blocked) {
        // A replayed refusal is state, not a terminal outcome. Recovery may already
        // have completed beyond this event; reconcile before deciding or resuming.
        const snapshot = await session.request<ThreadSnapshotResponse>(
          "GET",
          apiThreadSnapshotPath(threadId),
        );
        blocked = blockedOutcome(snapshot.liveState.pending);
        if (blocked) return blocked;
        const answer = answerForUserTurn(snapshot.turns, admitted.userTurnId);
        if (answer) {
          ourTurn = answer.id;
          if (["complete", "cancelled", "error"].includes(answer.status)) break;
        }
        continue;
      }
      if (followed.stoppedBy?.type !== "turn.failed") break;

      // A previous run can fail while this send's user turn is still queued.
      // If release already started its successor, follow that reply instead.
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      const answer = answerForUserTurn(snapshot.turns, admitted.userTurnId);
      if (answer) {
        ourTurn = answer.id;
        if (["complete", "cancelled", "error"].includes(answer.status)) break;
        continue;
      }
      if (snapshot.liveState.pending.items.some((item) => item.id === admitted.userTurnId)) {
        ourTurn = null;
        continue;
      }
      break;
    }
  } catch (error) {
    if (error instanceof CliError && error.code === "timeout") {
      const { reason, ...report } = await timeoutReport(session, threadId);
      return terminalResult(
        "thread.send",
        { outcome: "timeout", reason },
        {
          ...report,
          threadId,
          turnId: ourTurn,
          status: "timeout",
          finalText: null,
          error: `Run did not finish within ${input.timeoutMs}ms`,
        },
      );
    }
    throw error;
  } finally {
    transport.disconnect();
  }
  const snapshot = await session.request<ThreadSnapshotResponse>(
    "GET",
    apiThreadSnapshotPath(threadId),
  );
  blocked = blockedOutcome(snapshot.liveState.pending);
  if (blocked) return blocked;
  const turn = snapshot.turns.find((candidate) => candidate.id === ourTurn);
  const liveView = reduced.compare(snapshot, ourTurn ? [ourTurn] : [], truncated);
  const status: SendFields["status"] = interrupt
    ? "waiting_interrupt"
    : (turn?.status ?? "unknown");
  const claim: Claim = interrupt
    ? { outcome: "interrupt", reason: null }
    : status === "complete"
      ? { outcome: "complete", reason: null }
      : status === "cancelled"
        ? { outcome: "cancelled", reason: null }
        : status === "error"
          ? { outcome: "failed", reason: null }
          : { outcome: "unproven", reason: "unconfirmed" };
  // Writer admission reuses the user turn id as the inbox id. A finished
  // steered run cannot prove this send while that same message remains pending.
  if (
    claim.outcome === "complete" &&
    snapshot.liveState.pending.items.some((item) => item.id === admitted.userTurnId)
  ) {
    return terminalResult(
      "thread.send",
      { outcome: "unproven", reason: "owed" },
      {
        threadId,
        turnId: ourTurn,
        status,
        finalText: null,
        error: null,
        ...liveView,
        ...snapshotActivity(snapshot),
        next: [`./mf thread tail ${threadId} --until-idle`],
      },
    );
  }
  return terminalResult("thread.send", claim, {
    threadId,
    turnId: ourTurn,
    status,
    finalText: replyText(snapshot.turns, turn?.id ?? null),
    error: turn?.error ?? null,
    ...liveView,
    ...(interrupt
      ? {
          interrupt,
          next: [
            `./mf thread respond ${threadId} --turn ${interrupt.turnId} --interrupt ${interrupt.interruptId} --value '<json>'`,
          ],
        }
      : {}),
  });
}

function answerForUserTurn(turns: readonly Turn[], userTurnId: string): Turn | undefined {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const descendsFromUserTurn = (turn: Turn) => {
    let current: Turn | undefined = turn;
    while (current?.prevTurnId) {
      if (current.prevTurnId === userTurnId) return true;
      current = byId.get(current.prevTurnId);
    }
    return false;
  };
  return turns
    .filter((turn) => turn.role === "assistant" && descendsFromUserTurn(turn))
    .sort((left, right) => left.position - right.position)
    .at(-1);
}

/** Writes the terminal envelope (always the last NDJSON line) and returns the exit code. */
export const threadSendCommand: CommandSpec = {
  path: ["thread", "send"],
  summary: "Send and wait for the current CLI follow outcome (not yet proof of your reply)",
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
    `./mf thread send <id> "go" --mock @tools/mf/fixtures/mock-write.json --json | tail -1`,
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
      let admission: Awaited<ReturnType<typeof admitMessage>>;
      try {
        admission = await admitMessage(session, { threadId, ...input });
      } catch (error) {
        return finishResult(ctx.out, admissionFailure(error, threadId));
      }
      const { submissionId, admitted, mockScriptId } = admission;
      const terminal = terminalResult(
        "thread.send",
        { outcome: "accepted", reason: null },
        {
          threadId,
          submissionId,
          userTurnId: admitted.userTurnId,
          assistantTurnId: admitted.assistantTurnId,
          resumeAfterSeq: admitted.resumeAfterSeq,
          // Nothing waits here to remove it; clear it with `./mf mock clear --id` when done.
          mockScriptId,
        },
      );
      ctx.out.result(terminal.result, (value) =>
        [
          `accepted ${value.userTurnId} (./mf thread tail ${threadId} --since ${value.resumeAfterSeq})`,
          value.mockScriptId
            ? `mock script ${value.mockScriptId} stays queued (./mf mock clear --id ${value.mockScriptId})`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return terminal.exitCode;
    }
    const outcome = await sendMessage(session, ctx.out, { threadId, ...input });
    return finishResult(ctx.out, outcome, { full: flag(ctx, "full") });
  },
};
