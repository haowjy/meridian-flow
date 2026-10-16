/**
 * `./mf`'s adapter for the shared hand-back operation (`@meridian/thread-client`): the one
 * command lives in memory, the frozen request is printed to stderr before the post (even under
 * `--json`), and the outcome maps onto exit codes. The lifecycle (intent, post, classifying the
 * answer) is the package's; nothing here decides what a server answer means.
 */
import {
  createHandBackOperation,
  type FrozenRequest,
  type HandBackCommand,
  type HandBackOperation,
  type HandBackOutcome,
  type HttpPort,
  INITIAL_RUN_STATE_VIEW,
  type RunStateView,
  receiveRecord,
  viewRunStatePort,
} from "@meridian/thread-client";
import { CliError } from "../../core/cli-error";
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";

/** The HTTP port over a session: a status and decoded body, or `status: null` for no answer. */
export function sessionHttp(session: Session): HttpPort {
  return async (path, body) => {
    try {
      return { status: 200, body: await session.request("POST", path, body) };
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return error.httpStatus === undefined
        ? { status: null }
        : { status: error.httpStatus, body: undefined };
    }
  };
}

/** Prints the frozen request and its exact replay command to stderr before anything is posted. */
export function printFrozenRequest(
  out: Output,
  label: string,
  body: unknown,
  replayCommand: string,
): void {
  const json = JSON.stringify(body);
  const replay = `${replayCommand} --replay '${json}'`;
  out.always(`${label} request ${json}\nreplay: ${replay}`, {
    type: "request",
    label,
    request: body,
    replay,
  });
}

/** The error an ambiguous outcome exits with (4): the request and the replay command always ride along. */
export function ambiguousError(
  label: string,
  threadId: string,
  request: FrozenRequest,
  replayCommand: string,
): CliError {
  const replay = `${replayCommand} --replay '${JSON.stringify(request.body)}'`;
  return new CliError("unavailable", `${label} answer lost`, {
    hint: `The ${label} may have landed. Replay the same request, not a new press: ${replay}`,
    details: { threadId, request: request.body },
  });
}

/** The error a definite refusal exits with (1). */
export function refusedError(label: string, status: number): CliError {
  return new CliError("http_error", `${label} refused (HTTP ${status})`, { httpStatus: status });
}

type Input =
  | { press: { kind: "stop"; view: RunStateView } | { kind: "queue"; ids: readonly string[] } }
  | {
      replay:
        | {
            kind: "stop";
            requestId: string;
            body: Extract<HandBackCommand, { kind: "stop" }>["body"];
          }
        | { kind: "queue"; requestId: string; ids: readonly string[] };
    };

/**
 * Runs one hand-back command (a fresh press or an exact replay) through the shared operation and
 * returns the confirmed outcome; refusal and ambiguity throw the errors above.
 */
export async function runHandBack(options: {
  out: Output;
  session: Session;
  threadId: string;
  label: string;
  replayCommand: string;
  input: Input;
}): Promise<Extract<HandBackOutcome, { kind: "confirmed" }>> {
  const { out, session, threadId, label, replayCommand, input } = options;
  let view = INITIAL_RUN_STATE_VIEW;
  // CLI replay imports a wire request, not a saved client occurrence.
  let held: HandBackCommand | null =
    "replay" in input
      ? { ...input.replay, occurrence: { requestId: crypto.randomUUID(), attempt: 1 } }
      : null;
  const bodyOf = (command: HandBackCommand) =>
    command.kind === "stop"
      ? command.body
      : { requestId: command.requestId, ids: [...command.ids] };
  const operation: HandBackOperation = createHandBackOperation({
    threadId,
    ports: {
      http: sessionHttp(session),
      runState: viewRunStatePort(
        (change) => {
          view = change(view);
        },
        (record) => {
          view = receiveRecord(view, record);
        },
      ),
      removeTurns: () => {},
      store: {
        pending: () => (held ? [held] : []),
        record(command) {
          held = command;
          printFrozenRequest(out, label, bodyOf(command), replayCommand);
          return true;
        },
        accept: () => true,
        drop: () => true,
      },
    },
  });
  let outcome: HandBackOutcome | undefined;
  if ("replay" in input && held) {
    printFrozenRequest(out, label, bodyOf(held), replayCommand);
    outcome = (await operation.resume())[0];
  } else if ("press" in input) {
    outcome = await operation.press(input.press);
  }
  if (!outcome) throw new CliError("protocol", `${label} produced no outcome`);
  switch (outcome.kind) {
    case "confirmed":
      return outcome;
    case "refused":
      throw refusedError(label, outcome.status);
    case "ambiguous":
      throw ambiguousError(label, threadId, outcome.request, replayCommand);
    default:
      throw new CliError("protocol", `${label} could not be recorded (${outcome.kind})`);
  }
}
