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
import { acknowledgeAdmission, EMPTY_SYNCED_THREAD } from "@meridian/thread-client/sync";
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
import type { LiveDiff, LiveReason } from "./live-view";
import { createObserver, type Observer } from "./observe";
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
  /** The end-of-turn check of this follower's client state against the next read (`live-view.ts`); absent when nothing was followed. */
  liveView?: "matches" | "differs" | "not_observed";
  liveDiff?: LiveDiff[];
  liveReason?: LiveReason;
  /** Diagnostic observation stopped before all claimed terminal turns were checked. */
  observationIncomplete?: boolean;
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
  const references = [];
  // One owned lookup at a time: a failure leaves no sibling request running after return.
  for (const raw of refs) {
    const target = await resolveUri(session, projectId, raw);
    const document = await resolveDocument(session, projectId, target);
    references.push({
      uri: target.uri,
      documentId: document.documentId,
      label: document.entry.name,
      imageCapable: imageCapable(document.entry.fileType),
    });
  }
  return references;
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
  // The stream only decides when to look. Every claim comes from an applied read, through the
  // shared `messageFate`; a frame is never an input to it.
  let lastAnswering: string | null = null;
  let proven: Proven | null = null;
  // Once a read settles the claim, the stream gets a short bounded time to end the claimed turns
  // and be checked, so the printed log and the live view are whole. It never changes the claim.
  const CATCH_UP_MS = 1500;
  const deadlineAt = Date.now() + input.timeoutMs;
  const observer: Observer = createObserver({
    session,
    threadId,
    out,
    full: input.full,
    textStream: "err",
    deadlineAt,
    cursor: admitted.resumeAfterSeq,
    // The admission answer states the floor: no read older than the admitted message applies.
    cell: acknowledgeAdmission(
      EMPTY_SYNCED_THREAD,
      admitted.userTurnId,
      admitted.userTurnId,
      admitted.snapshotFloorNextSeq,
      new Date().toISOString(),
    ),
    onFrame(event) {
      const wantsLook =
        event.type === "interrupt.requested" ||
        (event.type === "event" &&
          (event.name === RUN_STATE_EVENT || event.name === MESSAGES_HANDED_BACK_EVENT));
      if (wantsLook) observer.refresh();
    },
    onLive: () => observer.refresh(),
    onGap: () => observer.refresh(),
    onRead(read) {
      const fate = messageFate({
        messageId: admitted.userTurnId,
        admittedVersion: admitted.runStateVersion,
        read,
      });
      if (fate.kind === "answering") lastAnswering = fate.last.id;
      proven ??= finalResult(fate, read, threadId, admitted.userTurnId);
    },
  });
  try {
    observer.start();
    try {
      await observer.until(() => proven !== null, deadlineAt);
    } catch (error) {
      if (error instanceof CliError && error.code === "timeout") {
        const last = observer.lastRead;
        const { reason, ...report } = classifyDeadline(last, threadId);
        return terminalResult(
          "thread.send",
          { outcome: "timeout", reason },
          {
            ...report,
            ...(last ? { snapshotStale: true } : { snapshotUnavailable: true }),
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
    }
    const claim = proven as Proven | null;
    if (!claim) throw new Error("Send stopped without a proving read");
    let observationIncomplete = false;
    try {
      await observer.until(
        () => observer.pending(claim.claimed, claim.turns).length === 0,
        Math.min(deadlineAt, Date.now() + CATCH_UP_MS),
      );
    } catch (error) {
      // Expected read/transport failures end diagnostics, not a result already proved by a read.
      // Unclassified exceptions are programming errors and must still escape.
      if (!(error instanceof CliError)) throw error;
      observationIncomplete = true;
    }
    const result = withLiveView(claim, observer);
    if (observationIncomplete) result.result.observationIncomplete = true;
    return result;
  } finally {
    observer.close();
  }
}

/**
 * A result frozen with the read that proved it; `claimed` is the assistant turns of the message's
 * chain in that read, which `liveView` checks.
 */
type Proven = { outcome: SendOutcome; turns: ReadonlyMap<string, Turn>; claimed: string[] };

/** The CLI's final result for what `messageFate` proved, or null to keep following. */
function finalResult(
  fate: MessageFate,
  snapshot: ThreadSnapshotResponse,
  threadId: string,
  userTurnId: string,
): Proven | null {
  const base = { threadId, userTurnId };
  const none = { turnId: null, finalText: null, error: null };
  // The assistant turns of the message's chain, in the proving read: what the check is asked about.
  const assistantTurns = (chain: readonly string[]) =>
    chain.filter((id) => {
      const role = snapshot.turns.find((turn) => turn.id === id)?.role;
      return role === undefined || role === "assistant";
    });
  const done = (outcome: SendOutcome, claimed: string[] = []): Proven => ({
    outcome,
    turns: new Map(snapshot.turns.map((turn) => [turn.id, turn])),
    claimed,
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
        assistantTurns(fate.chain),
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
        assistantTurns(fate.chain),
      );
    }
  }
}

/** The frozen result plus `liveView` from the checks, read after the bounded catch-up. */
function withLiveView({ outcome, claimed }: Proven, observer: Observer): SendOutcome {
  return { ...outcome, result: { ...outcome.result, ...observer.liveView(claimed) } };
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
