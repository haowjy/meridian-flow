/**
 * useRetryStandIns — the optimistic half of a Retry that writes a new turn.
 *
 * Pressing Retry mints the new turn's id and shows its stand-in at once, then
 * asks the server to write it. The server's turn replaces the stand-in by id,
 * first from the response and then from the snapshot. A refusal (409: the chat
 * moved on first; or the server is shutting down) wrote nothing: the stand-in
 * goes, the turn the writer pressed is noted with a generic "Couldn't retry.",
 * and the snapshot refreshes to show the true state. A lost
 * request keeps the stand-in, failed, and its Retry re-sends under the same
 * id: the lost request may have arrived. The server answers that replay with
 * the execution the first request started, or `retry_pending` (503) while it
 * can't tell yet: the same id goes again after the server's `Retry-After`, a
 * bounded number of times, then waits for the writer's Retry like a lost request.
 *
 * A stand-in whose request's reservation ended without creating its turn (a
 * Retry whose compaction was stopped) is retired: the caller's `retired` reads
 * that from run identity, by execution or by the request id the reservation
 * records.
 *
 * The handoff brief's Retry (`useHandoffBrief`) and a failed reply's Retry
 * (`useReplyRetry`) supply what to post and how the stand-in looks.
 */
import { t } from "@lingui/core/macro";
import { REPLY_RETRY_PENDING_CODE, type Turn } from "@meridian/contracts/protocol";
import { placeStandIns } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpResponseError, httpErrorStatus, retryAfterMs } from "@/client/api/http-client";
import { isMeridianApiError } from "@/client/api/meridian-error";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";
import { reportRetryRefused } from "./error-telemetry";

export type StandInRequest = "sending" | "sent" | "failed";

type StandIn = {
  /** The stand-in, then the server's turn once the response lands. */
  turn: Turn;
  request: StandInRequest;
  /** The turn whose Retry the writer pressed. */
  from: string;
  /** The execution the server answered the request with; null until it does (or for no execution). */
  executionId: string | null;
};

/** What a stand-in's request is known by: its id and the execution answering it. */
export type StandInIdentity = { id: string; executionId: string | null };

/** What the server answered: the new turn when it has one, and the execution answering it. */
export type StandInAnswer = { turn: Turn | null; executionId: string | null };

export type RetryStandIns = {
  /** Stand-ins the store does not have yet, in the order they were asked for. */
  standIns: readonly Turn[];
  /** Where a stand-in's request is; null once the store has it, or for any other turn. */
  requestOf: (turnId: string) => StandInRequest | null;
  /** Turns whose Retry the server refused; nothing was written. */
  refused: ReadonlySet<string>;
  /**
   * Failed replies whose Retry is pending or accepted but no stored turn names it yet
   * (`metadata.retryOf`): `viewTranscript` leaves them out, so the Retry stands in their place.
   */
  retried: ReadonlySet<string>;
  /**
   * Retry from `from`. A failed stand-in re-sends under its own id; any other
   * turn gets a new stand-in from `build`, which may decline with null.
   */
  retry: (from: Turn, build: (input: { id: string; leaf: Turn | null }) => Turn | null) => void;
};

const NO_REFUSALS: ReadonlySet<string> = new Set();

/** The server answered and wrote nothing: the chat moved on, or it is shutting down. */
function isRetryRefusal(error: unknown): boolean {
  return (
    httpErrorStatus(error) === 409 ||
    (error instanceof HttpResponseError && error.message === "runtime_shutting_down")
  );
}

/** The server can't tell yet whether this replay is its own first request: ask again. */
function isRetryPending(error: unknown): boolean {
  if (httpErrorStatus(error) !== 503) return false;
  if (isMeridianApiError(error)) return error.code === REPLY_RETRY_PENDING_CODE;
  return error instanceof HttpResponseError && error.message === REPLY_RETRY_PENDING_CODE;
}

/** The wait when a `retry_pending` answer carries no usable `Retry-After`. */
const RETRY_PENDING_DELAY_MS = 1000;
/** Automatic sends per writer press while the server answers `retry_pending`. */
export const RETRY_PENDING_ATTEMPTS = 8;

export function useRetryStandIns(input: {
  threadId: string;
  storedTurns: readonly Turn[];
  /**
   * Ask the server for turn `id`, retrying `from` (the turn first pressed).
   * A null turn: accepted, but the server has no turn to show yet.
   */
  post: (id: string, from: string) => Promise<StandInAnswer>;
  /** On the failed stand-in and announced, when the request never answered. */
  lostCopy: string;
  /** Whether a stand-in's reservation ended without creating its turn: nothing will now. */
  retired?: (standIn: StandInIdentity) => boolean;
  /**
   * The Retry replaces the turn it retries in the transcript (a failed reply's Retry), so the
   * pressed turn stays out of view while the Retry is pending and until a stored turn carries
   * `metadata.retryOf` for it. Not for a handoff brief's Retry.
   */
  supersedes?: boolean;
}): RetryStandIns {
  const { retired, supersedes = false } = input;
  const { threadId, storedTurns } = input;
  const [local, setLocal] = useState<readonly StandIn[]>([]);
  const [refused, setRefused] = useState(NO_REFUSALS);
  const localRef = useRef(local);
  localRef.current = local;
  const storedRef = useRef(storedTurns);
  storedRef.current = storedTurns;
  // Read at call time: callers pass fresh closures and copy each render.
  const optionsRef = useRef(input);
  optionsRef.current = input;
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const storedIds = useMemo(() => new Set(storedTurns.map((turn) => turn.id)), [storedTurns]);
  // The failed replies a stored turn says were retried. The Retry's first reserved turn carries
  // it, which can be a compaction or a switch turn ahead of the reply.
  const evidenced = useMemo(() => {
    const targets = new Set<string>();
    for (const turn of storedTurns) {
      const target = (turn.metadata as { retryOf?: unknown } | null)?.retryOf;
      if (typeof target === "string") targets.add(target);
    }
    return targets;
  }, [storedTurns]);
  // Once the snapshot has the turn, it is the authority (and, for a Retry that supersedes, has
  // the turn that says so). A request whose reservation ended without the turn is over:
  // nothing will create it now.
  const settles = useCallback(
    (entry: StandIn) =>
      (storedIds.has(entry.turn.id) && (!supersedes || evidenced.has(entry.from))) ||
      (retired?.({ id: entry.turn.id, executionId: entry.executionId }) ?? false),
    [evidenced, retired, storedIds, supersedes],
  );
  useEffect(() => {
    setLocal((current) => {
      const next = current.filter((entry) => !settles(entry));
      return next.length === current.length ? current : next;
    });
  }, [settles]);

  const patch = useCallback((id: string, change: (entry: StandIn) => StandIn) => {
    setLocal((current) => current.map((entry) => (entry.turn.id === id ? change(entry) : entry)));
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }, [queryClient, threadId]);

  const send = useCallback(
    (id: string, from: string, attempt = 1) => {
      optionsRef.current.post(id, from).then(
        (answer) => {
          patch(id, (entry) => ({
            ...entry,
            turn: answer.turn ?? entry.turn,
            executionId: answer.executionId ?? entry.executionId,
            request: "sent",
          }));
          refresh();
        },
        (error: unknown) => {
          // Still undecided: the same id again after the server's wait, while
          // the budget lasts. Past it the request stays unresolved, never refused.
          if (isRetryPending(error) && attempt < RETRY_PENDING_ATTEMPTS) {
            setTimeout(() => {
              if (mounted.current && localRef.current.some((entry) => entry.turn.id === id))
                sendRef.current(id, from, attempt + 1);
            }, retryAfterMs(error) ?? RETRY_PENDING_DELAY_MS);
            return;
          }
          // A refusal (409: the chat moved on first; or the server is shutting
          // down) wrote nothing. The writer sees one generic line; the cause
          // goes to diagnostics.
          if (isRetryRefusal(error)) {
            reportRetryRefused({ threadId, from, status: httpErrorStatus(error), error });
            setLocal((current) => current.filter((entry) => entry.turn.id !== id));
            setRefused((current) => new Set(current).add(from));
            announce(t`Couldn't retry.`);
            refresh();
            return;
          }
          const copy = optionsRef.current.lostCopy;
          announceError(copy);
          // The stand-in reads its failure from its status, as a server failure does.
          patch(id, (entry) => ({
            ...entry,
            request: "failed",
            turn: { ...entry.turn, status: "error", error: copy },
          }));
        },
      );
    },
    [patch, refresh, threadId],
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  const retry = useCallback<RetryStandIns["retry"]>(
    (from, build) => {
      setRefused((current) => {
        if (!current.has(from.id)) return current;
        const next = new Set(current);
        next.delete(from.id);
        return next;
      });
      const lost = localRef.current.find(
        (entry) => entry.turn.id === from.id && entry.request === "failed",
      );
      if (lost) {
        // Same id: if the lost request did reach the server, this replays it.
        patch(from.id, (entry) => ({
          ...entry,
          request: "sending",
          turn: { ...entry.turn, status: "pending", error: null },
        }));
        send(from.id, lost.from);
        return;
      }
      const id = crypto.randomUUID();
      const leaf =
        placeStandIns(
          [...storedRef.current],
          localRef.current.map((entry) => entry.turn),
        ).at(-1) ?? null;
      const standIn = build({ id, leaf });
      if (!standIn) return;
      setLocal((current) => [
        ...current,
        { turn: standIn, request: "sending", from: from.id, executionId: null },
      ]);
      send(id, from.id);
    },
    [patch, send],
  );

  const unsettled = useMemo(() => local.filter((entry) => !settles(entry)), [local, settles]);
  // An entry the store has by id but whose Retry it doesn't show yet is no stand-in, only a target.
  const unstored = useMemo(
    () => unsettled.filter((entry) => !storedIds.has(entry.turn.id)),
    [storedIds, unsettled],
  );
  const standIns = useMemo(() => unstored.map((entry) => entry.turn), [unstored]);
  const requestOf = useCallback(
    (turnId: string) => unstored.find((entry) => entry.turn.id === turnId)?.request ?? null,
    [unstored],
  );
  const retried = useMemo(
    () => new Set(supersedes ? unsettled.map((entry) => entry.from) : []),
    [supersedes, unsettled],
  );

  return { standIns, requestOf, refused, retried, retry };
}
