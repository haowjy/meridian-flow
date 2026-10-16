/** Thread driving commands: create, send (wait by default), tail, cancel, respond. */
import { randomUUID } from "node:crypto";
import {
  type AdmissionLookup,
  apiThreadAdmissionPath,
  apiThreadMessagePath,
  apiThreadSkillsPath,
  apiThreadSnapshotPath,
  MESSAGES_HANDED_BACK_EVENT,
  RUN_STATE_EVENT,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadAvailableSkillsResponse,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { interruptIdForBlock, type Turn } from "@meridian/contracts/threads";
import {
  buildMessageDoc,
  imageCapable,
  type MessageFate,
  messageFate,
  serializeMessageDoc,
} from "@meridian/thread-client";
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
  classifyDeadline,
  finishResult,
  snapshotActivity,
  type TerminalResult,
  terminalResult,
} from "./result";
import { followThread } from "./stream";
import { createThreadClient } from "./transport";

export type SendFields = {
  submissionId?: string;
  threadId: string;
  /** The admitted message: the user turn the fate is proven for. */
  userTurnId?: string;
  /** The reply that took the message; `turnId` is the last reply in its chain. */
  answeredBy?: string;
  turnId: string | null;
  status: Turn["status"] | "timeout" | "unknown" | "blocked" | "handed_back";
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
  // The stream only decides when to look. Every claim comes from a confirming snapshot read
  // through the shared `messageFate`; a frame is never an input to it.
  let lastAnswering: string | null = null;
  // The newest snapshot that completed; the deadline classifies it and never reads another.
  let lastSnapshot: ThreadSnapshotResponse | null = null;
  let proven: Proven | null = null;
  // Once a snapshot settles the claim, the stream gets a short bounded time to reach that
  // snapshot's position, so the printed log and the live view are whole. It never changes the claim.
  let catchUpUntil = Infinity;
  const CATCH_UP_MS = 1500;
  const reduced = new ReducedThread(threadId);
  const transport = createThreadClient(session);
  const deadlineAt = Date.now() + input.timeoutMs;
  let followed: Awaited<ReturnType<typeof followThread>>;
  try {
    followed = await followThread({
      session,
      transport,
      threadId,
      lastSeq: admitted.resumeAfterSeq,
      deadlineAt,
      out,
      full: input.full,
      textStream: "err",
      reduced,
      wakeOnGap: true,
      currentDeadline: () => catchUpUntil,
      shouldStop: (event: CliEvent) =>
        proven !== null ||
        event.type === "interrupt.requested" ||
        (event.type === "event" &&
          (event.name === RUN_STATE_EVENT || event.name === MESSAGES_HANDED_BACK_EVENT)),
      shouldStopState: () => true,
      async confirmStop(_turnIds, seenSeq) {
        const behind = (snapshot: ThreadSnapshotResponse) =>
          BigInt(seenSeq) < BigInt(snapshot.liveState.resumeAfterSeq);
        if (proven) return !behind(proven.snapshot);
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new CliError("timeout", "Send deadline reached");
        const snapshot = await session.request<ThreadSnapshotResponse>(
          "GET",
          apiThreadSnapshotPath(threadId),
          undefined,
          { timeoutMs: remaining },
        );
        lastSnapshot = snapshot;
        const fate = messageFate({
          messageId: admitted.userTurnId,
          admittedVersion: admitted.runStateVersion,
          record: snapshot.liveState.runState,
          turns: snapshot.turns,
        });
        if (fate.kind === "answering") lastAnswering = fate.last.id;
        proven = finalResult(fate, snapshot, threadId, admitted.userTurnId);
        if (!proven) return false;
        if (!behind(snapshot)) return true;
        catchUpUntil = Math.min(deadlineAt, Date.now() + CATCH_UP_MS);
        return false;
      },
    });
  } catch (error) {
    if (
      proven &&
      error instanceof CliError &&
      (error.code === "timeout" || error.code === "unavailable" || error.code === "protocol")
    ) {
      // The claim stands. The catch-up only feeds the printed log and `liveView`: an incomplete
      // log, so `liveView` is `not_observed`; a failure here never replaces a proven claim.
      return withLiveView(proven, reduced, true);
    }
    if (error instanceof CliError && error.code === "timeout") {
      const { reason, ...report } = classifyDeadline(lastSnapshot, threadId);
      return terminalResult(
        "thread.send",
        { outcome: "timeout", reason },
        {
          ...report,
          ...(lastSnapshot ? { snapshotStale: true } : { snapshotUnavailable: true }),
          threadId,
          userTurnId: admitted.userTurnId,
          turnId: lastAnswering,
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
  if (!proven) throw new Error("Send stopped without a confirming snapshot");
  return withLiveView(proven, reduced, followed.truncated);
}

/** A result frozen with the snapshot that proved it; `compared` is the turn `liveView` checks. */
type Proven = { outcome: SendOutcome; snapshot: ThreadSnapshotResponse; compared: string | null };

/** The CLI's final result for what `messageFate` proved, or null to keep following. */
function finalResult(
  fate: MessageFate,
  snapshot: ThreadSnapshotResponse,
  threadId: string,
  userTurnId: string,
): Proven | null {
  const base = { threadId, userTurnId };
  const none = { turnId: null, finalText: null, error: null };
  const done = (outcome: SendOutcome, compared: string | null = null): Proven => ({
    outcome,
    snapshot,
    compared,
  });
  switch (fate.kind) {
    case "waiting":
      return fate.blocked
        ? done(
            terminalResult(
              "thread.send",
              { outcome: "failed", reason: "credits_exhausted" },
              { ...base, ...none, status: "blocked", error: "Your message is waiting for usage" },
            ),
          )
        : null;
    case "handedBack":
      return done(
        terminalResult(
          "thread.send",
          { outcome: "handed_back", reason: null },
          { ...base, ...none, status: "handed_back" },
        ),
      );
    case "forgotten":
      return done(
        terminalResult(
          "thread.send",
          { outcome: "failed", reason: "forgotten" },
          {
            ...base,
            ...none,
            status: "error",
            error: "The chat moved past this message's failed reply, so no reply answers it",
          },
        ),
      );
    case "unproven":
      return done(
        terminalResult(
          "thread.send",
          { outcome: "unproven", reason: fate.reason },
          {
            ...base,
            ...none,
            status: "unknown",
            ...snapshotActivity(snapshot),
            next: [`./mf thread tail ${threadId} --until-idle`],
          },
        ),
      );
    case "answering": {
      const { last } = fate;
      const interruptId = last.blocks
        .map(interruptIdForBlock)
        .filter((id): id is string => id !== null)
        .at(-1);
      if (last.status !== "waiting_interrupt" || !interruptId) return null;
      return done(
        terminalResult(
          "thread.send",
          { outcome: "interrupt", reason: null },
          {
            ...base,
            answeredBy: fate.answeredBy,
            turnId: last.id,
            status: "waiting_interrupt",
            finalText: null,
            error: null,
            interrupt: { turnId: last.id, interruptId },
            next: [
              `./mf thread respond ${threadId} --turn ${last.id} --interrupt ${interruptId} --value '<json>'`,
            ],
          },
        ),
        last.id,
      );
    }
    case "answered": {
      const { last } = fate;
      const claim: Claim =
        last.status === "complete"
          ? { outcome: "complete", reason: null }
          : last.status === "cancelled"
            ? { outcome: "cancelled", reason: null }
            : last.status === "error"
              ? { outcome: "failed", reason: null }
              : { outcome: "unproven", reason: "unconfirmed" };
      return done(
        terminalResult("thread.send", claim, {
          ...base,
          answeredBy: fate.answeredBy,
          turnId: last.id,
          status: last.status,
          finalText: replyText(snapshot.turns, last.id),
          error: last.error,
        }),
        last.id,
      );
    }
  }
}

/** The frozen result plus this follower's `liveView`, read after the bounded catch-up. */
function withLiveView(
  { outcome, snapshot, compared }: Proven,
  reduced: ReducedThread,
  truncated: boolean,
): SendOutcome {
  if (!compared) return outcome;
  return {
    ...outcome,
    result: { ...outcome.result, ...reduced.compare(snapshot, [compared], truncated) },
  };
}

/** Writes the terminal envelope (always the last NDJSON line) and returns the exit code. */
export const threadSendCommand: CommandSpec = {
  path: ["thread", "send"],
  summary:
    "Send and wait: proves from one snapshot what became of this message and the last reply in its chain",
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
