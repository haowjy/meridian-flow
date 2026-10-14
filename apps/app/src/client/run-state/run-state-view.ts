/**
 * The run-state view: the server's latest record of a chat, and this device's
 * intents that the record does not yet cover.
 *
 * A record is a server fact stamped with a `version` (an event seq). Everything the
 * server says about a chat's run state, whether it arrives in a snapshot, a socket frame
 * or an HTTP answer, is received as a record, and versions are compared with
 * `compareSeq` and nothing else. An intent is something the writer did that the server
 * has not shown yet. This module owns the one rule for newness and retirement:
 *
 * - a record replaces the current one only if it is newer;
 * - an intent with an answer leaves once the record's version is at or after its answer;
 * - an intent with no answer leaves only by `dropIntent`.
 *
 * Folds (`fold-switches.ts`) are pure selectors over the view and decide nothing about
 * either. This directory imports only `@meridian/contracts`.
 */
import { compareSeq } from "@meridian/contracts/protocol";
import type { PendingInboxItem } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";

export type RunStateRecord = {
  version: string;
  /** The chat's applied write mode. */
  mode: AiWriteMode;
  /** The unacknowledged inbox, including the queued write-mode switch as a control row. */
  items: readonly PendingInboxItem[];
};

export type Intent =
  | {
      kind: "switch";
      id: string;
      /** The local journal's per-chat order: unique and monotonic. */
      order: number;
      mode: AiWriteMode;
      /** The version of the server's answer, once it has answered. */
      answer: string | null;
      /** The last attempt did not succeed: shown with Retry, and the fold leaves it out. */
      failed?: boolean;
      /** Posted and not refused: the server may hold it, so Retry only. */
      awaitingServer?: boolean;
    }
  | {
      kind: "withdraw";
      /** The control withdrawn. */
      id: string;
      order: number;
      answer: string | null;
      /** The request failed: the row stays, with the failure on it. */
      failed?: boolean;
    };

export type RunStateView = {
  record: RunStateRecord | null;
  intents: readonly Intent[];
};

export const EMPTY_VIEW: RunStateView = { record: null, intents: [] };

const same = (a: Intent, kind: Intent["kind"], id: string) => a.kind === kind && a.id === id;

const covered = (record: RunStateRecord | null, answer: string | null) =>
  answer !== null && record !== null && compareSeq(record.version, answer) >= 0;

function retire(view: RunStateView): RunStateView {
  const intents = view.intents.filter((intent) => !covered(view.record, intent.answer));
  return intents.length === view.intents.length ? view : { ...view, intents };
}

/** Take a server record: it replaces the current one only if newer, then covered intents leave. */
export function receiveRecord(view: RunStateView, record: RunStateRecord): RunStateView {
  const current = view.record;
  if (current && compareSeq(record.version, current.version) <= 0) return view;
  return retire({ ...view, record });
}

/**
 * Add an intent, or replace the same one (keeping its answer unless the new one has an
 * answer). An intent the record already covers is skipped.
 */
export function addIntent(view: RunStateView, intent: Intent): RunStateView {
  const existing = view.intents.find((known) => same(known, intent.kind, intent.id));
  const answer = intent.answer ?? existing?.answer ?? null;
  if (covered(view.record, answer)) return dropIntent(view, intent.kind, intent.id);
  const next = { ...intent, answer } as Intent;
  return {
    ...view,
    intents: existing
      ? view.intents.map((known) => (known === existing ? next : known))
      : [...view.intents, next],
  };
}

/** Stamp the server's answer on an intent, then retire it if the record already covers it. */
export function answerIntent(
  view: RunStateView,
  kind: Intent["kind"],
  id: string,
  version: string,
): RunStateView {
  const existing = view.intents.find((known) => same(known, kind, id));
  if (!existing) return view;
  const answer =
    existing.answer !== null && compareSeq(existing.answer, version) >= 0
      ? existing.answer
      : version;
  return retire({
    ...view,
    intents: view.intents.map((known) => (known === existing ? { ...known, answer } : known)),
  });
}

/** Remove an intent the server will never answer: a refusal, a failed request, a local cancel. */
export function dropIntent(view: RunStateView, kind: Intent["kind"], id: string): RunStateView {
  const intents = view.intents.filter((known) => !same(known, kind, id));
  return intents.length === view.intents.length ? view : { ...view, intents };
}
