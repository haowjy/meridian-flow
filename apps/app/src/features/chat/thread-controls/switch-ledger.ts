/**
 * The switch ledger: one pure, per-chat record of every write-mode switch this
 * tab has heard of, and the only owner of what the writer sees of one.
 *
 * Sources feed it events (the submission journal, the server's answer, the
 * socket's pending inbox, a fetched snapshot, the rendered transcript, the
 * writer's Withdraw). No source decides on its own that a switch is over. Each
 * entry moves forward through
 *
 *   sending, posted, queued, applied, gone
 *
 * and `gone` and `applied` are reached only through the evidence below.
 *
 * - `sending`: the journal holds the record, not yet posted. `posted`: it was
 *   marked posted and nothing has answered. `failed` is a flag on these two.
 * - `queued`: an answer with `pending`, the inbox, or a snapshot's pending
 *   inbox lists it. `applied`: an answer with a turn id, or any divider names it.
 * - `applied` retires once the transcript this tab renders holds its divider.
 * - `gone` comes from a `null`/`null` answer (cancel-out), a server Withdraw
 *   that answered `withdrawn`, a server 404 for a switch the journal no longer
 *   holds (the server never had it), a local Withdraw the driver allowed, or a
 *   snapshot that shows the id neither pending nor as a divider and whose
 *   request began after the entry's last live observation. The server reads
 *   turns and inbox in one transaction, so absence in a fresh snapshot is proof.
 *
 * A record leaving the journal, or the id leaving the inbox, proves nothing:
 * the entry stays where it was, `needsProof` turns true, and the caller asks
 * for a snapshot. `at` and `request` are readings of one counter of snapshot
 * requests started; a snapshot proves absence only when `request > observedAt`,
 * so a failed, skipped or joined-older fetch never does.
 *
 * Display derives from here alone: `switchRows`, `overlaidMode`, and
 * `transitions` (what to announce and when caches are stale).
 */
import type { AiWriteMode } from "@meridian/contracts/works";
import type { QueuedControl, QueuedControlStatus } from "./thread-controls";

export type LedgerState = "sending" | "posted" | "queued" | "applied" | "gone";

export type LedgerEntry = {
  id: string;
  mode: AiWriteMode;
  /** The journal's place in the chat's order; `null` for a switch only the server has shown. */
  seq: number | null;
  /** The pending inbox's order, for a switch with no `seq`. */
  serverSeq: number;
  state: LedgerState;
  failed: boolean;
  /** Posted and not refused: the server may hold it, so Retry only, no local Withdraw. */
  awaitingServer: boolean;
  inJournal: boolean;
  inInbox: boolean;
  /** The highest reading of the request counter at which any source showed it. */
  observedAt: number;
  /** The highest request of a snapshot that listed it, 0 for none. */
  provedAt: number;
  /** A divider naming it is in the transcript this tab renders. */
  rendered: boolean;
  /** A snapshot's turns held its divider, so the snapshot's thread mode includes it. */
  snapshotSeen: boolean;
  /** Present when the ledger was first settled: its later queued state is not news. */
  silent: boolean;
  withdrawal?: "withdrawing" | "failed";
};

export type Ledger = {
  entries: readonly LedgerEntry[];
  /** Control ids that a rendered divider names. A stale inbox frame cannot revive these. */
  named: ReadonlySet<string>;
  /** Rendered divider turn ids, with the mode each switched to. */
  dividers: ReadonlyMap<string, AiWriteMode>;
  /** History and the first projection are in; what arrives after is news. */
  settled: boolean;
};

export const EMPTY_LEDGER: Ledger = {
  entries: [],
  named: new Set(),
  dividers: new Map(),
  settled: false,
};

export type JournalRecord = {
  id: string;
  mode: AiWriteMode;
  seq: number;
  posted: boolean;
  /** The server refused it: Withdraw is local. */
  refused: boolean;
  failed: boolean;
};

export type LedgerEvent =
  | { type: "journal"; records: readonly JournalRecord[]; at: number }
  | {
      type: "inbox";
      items: readonly { id: string; mode: AiWriteMode; serverSeq: number }[];
      at: number;
    }
  | {
      type: "answer";
      id: string;
      mode: AiWriteMode;
      /** `pending` or `turnId` of the server's answer; neither means it cancelled out. */
      result: "queued" | "applied" | "cancelled";
      at: number;
    }
  | {
      type: "snapshot";
      /** The request counter value taken when the snapshot's fetch started. */
      request: number;
      pending: readonly { id: string; mode: AiWriteMode; serverSeq: number }[];
      dividers: readonly { controlId: string | null }[];
    }
  | {
      type: "transcript";
      dividers: readonly { turnId: string; controlId: string | null; mode: AiWriteMode }[];
    }
  | { type: "settled" }
  | { type: "withdraw_started"; id: string }
  | {
      type: "withdraw_done";
      id: string;
      outcome: "removed" | "withdrawn" | "already_started" | "not_found" | "kept";
    }
  | { type: "withdraw_failed"; id: string };

/** The watermark only rises: a later reading from any live source never lowers it. */
const raise = (entry: LedgerEntry, at: number): number => Math.max(entry.observedAt, at);

const RANK: Record<LedgerState, number> = { sending: 0, posted: 1, queued: 2, applied: 3, gone: 4 };

function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  if (a.seq === null || b.seq === null) {
    if (a.seq === b.seq) return a.serverSeq - b.serverSeq;
    return a.seq === null ? -1 : 1;
  }
  return a.seq - b.seq;
}

function advance(entry: LedgerEntry, state: LedgerState): LedgerEntry {
  if (entry.state === "gone" || RANK[state] <= RANK[entry.state]) return entry;
  return { ...entry, state, failed: RANK[state] > RANK.posted ? false : entry.failed };
}

function blank(id: string, mode: AiWriteMode, at: number, state: LedgerState): LedgerEntry {
  return {
    id,
    mode,
    seq: null,
    serverSeq: 0,
    state,
    failed: false,
    awaitingServer: false,
    inJournal: false,
    inInbox: false,
    observedAt: at,
    provedAt: 0,
    rendered: false,
    snapshotSeen: false,
    silent: false,
  };
}

/** Change one entry, creating it first when this is the first the ledger hears of it. */
function upsert(
  ledger: Ledger,
  id: string,
  mode: AiWriteMode,
  at: number,
  initial: LedgerState,
  change: (entry: LedgerEntry) => LedgerEntry,
): Ledger {
  const known = ledger.entries.find((entry) => entry.id === id);
  if (!known && ledger.named.has(id)) return ledger;
  const entries = known
    ? ledger.entries.map((entry) => (entry.id === id ? change(entry) : entry))
    : [...ledger.entries, change(blank(id, mode, at, initial))];
  return { ...ledger, entries: [...entries].sort(compareEntries) };
}

function patch(ledger: Ledger, id: string, change: (entry: LedgerEntry) => LedgerEntry): Ledger {
  if (!ledger.entries.some((entry) => entry.id === id)) return ledger;
  return {
    ...ledger,
    entries: ledger.entries.map((entry) => (entry.id === id ? change(entry) : entry)),
  };
}

function mapEntries(ledger: Ledger, change: (entry: LedgerEntry) => LedgerEntry): Ledger {
  let changed = false;
  const entries = ledger.entries.map((entry) => {
    const next = change(entry);
    if (next !== entry) changed = true;
    return next;
  });
  return changed ? { ...ledger, entries } : ledger;
}

const gone = (entry: LedgerEntry): LedgerEntry =>
  entry.state === "gone"
    ? entry
    : { ...entry, state: "gone", failed: false, withdrawal: undefined };

function step(ledger: Ledger, event: LedgerEvent): Ledger {
  switch (event.type) {
    case "journal": {
      let next = ledger;
      const held = new Set(event.records.map((record) => record.id));
      for (const record of event.records) {
        const state: LedgerState = next.named.has(record.id)
          ? "applied"
          : record.posted
            ? "posted"
            : "sending";
        next = upsert(next, record.id, record.mode, event.at, state, (entry) => {
          const advanced = advance(entry, state);
          return {
            ...advanced,
            seq: record.seq,
            inJournal: true,
            observedAt: raise(advanced, event.at),
            failed: RANK[advanced.state] <= RANK.posted && record.failed,
            awaitingServer: record.posted && !record.refused,
          };
        });
      }
      return mapEntries(next, (entry) =>
        entry.inJournal && !held.has(entry.id)
          ? {
              ...entry,
              inJournal: false,
              awaitingServer: false,
              failed: false,
              observedAt: raise(entry, event.at),
            }
          : entry,
      );
    }
    case "inbox": {
      const listed = new Set(event.items.map((item) => item.id));
      let next = ledger;
      for (const item of event.items) {
        next = upsert(next, item.id, item.mode, event.at, "queued", (entry) => ({
          ...advance(entry, "queued"),
          serverSeq: item.serverSeq,
          inInbox: true,
          observedAt: raise(entry, event.at),
        }));
      }
      return mapEntries(next, (entry) =>
        entry.inInbox && !listed.has(entry.id)
          ? { ...entry, inInbox: false, observedAt: raise(entry, event.at) }
          : entry,
      );
    }
    case "answer": {
      let next = upsert(
        ledger,
        event.id,
        event.mode,
        event.at,
        event.result === "cancelled" ? "queued" : event.result,
        (entry) => {
          if (event.result === "cancelled") return gone(entry);
          return { ...advance(entry, event.result), observedAt: raise(entry, event.at) };
        },
      );
      if (event.result !== "cancelled") return next;
      // The server withdrew the queued switches to the other mode that came before it.
      const at = next.entries.findIndex((entry) => entry.id === event.id);
      const before = new Set(
        next.entries
          .slice(0, at < 0 ? next.entries.length : at)
          .filter(
            (entry) =>
              entry.mode !== event.mode &&
              !entry.failed &&
              (entry.state === "sending" || entry.state === "posted" || entry.state === "queued"),
          )
          .map((entry) => entry.id),
      );
      next = mapEntries(next, (entry) => (before.has(entry.id) ? gone(entry) : entry));
      return next;
    }
    case "snapshot": {
      const named = new Set(event.dividers.flatMap((d) => (d.controlId ? [d.controlId] : [])));
      const listed = new Set(event.pending.map((item) => item.id));
      let next = ledger;
      for (const item of event.pending) {
        next = upsert(next, item.id, item.mode, event.request, "queued", (entry) =>
          named.has(item.id) ? entry : { ...advance(entry, "queued"), serverSeq: item.serverSeq },
        );
      }
      return mapEntries(next, (entry) => {
        if (entry.state === "gone") return entry;
        // A snapshot that shows the entry is a reading of it at its request.
        const shows = {
          observedAt: raise(entry, event.request),
          provedAt: Math.max(entry.provedAt, event.request),
        };
        if (named.has(entry.id))
          return { ...advance(entry, "applied"), ...shows, snapshotSeen: true };
        if (listed.has(entry.id)) return { ...entry, ...shows };
        const sourced = entry.inJournal || entry.inInbox;
        return !sourced && event.request > entry.observedAt ? gone(entry) : entry;
      });
    }
    case "transcript": {
      if (event.dividers.every((divider) => ledger.dividers.has(divider.turnId))) return ledger;
      const dividers = new Map(ledger.dividers);
      const named = new Set(ledger.named);
      for (const divider of event.dividers) {
        dividers.set(divider.turnId, divider.mode);
        if (divider.controlId) named.add(divider.controlId);
      }
      return { ...ledger, dividers, named };
    }
    case "settled":
      return ledger.settled
        ? ledger
        : {
            ...ledger,
            settled: true,
            entries: ledger.entries.map((entry) => ({ ...entry, silent: true })),
          };
    case "withdraw_started":
      return patch(ledger, event.id, (entry) => ({ ...entry, withdrawal: "withdrawing" }));
    case "withdraw_failed":
      return patch(ledger, event.id, (entry) => ({ ...entry, withdrawal: "failed" }));
    case "withdraw_done":
      return patch(ledger, event.id, (entry) => {
        switch (event.outcome) {
          case "removed":
          case "withdrawn":
            return gone(entry);
          case "already_started":
            return { ...advance(entry, "applied"), withdrawal: undefined };
          case "not_found":
            // The server never had it, unless the journal still holds a record it may yet post.
            return entry.inJournal ? { ...entry, withdrawal: undefined } : gone(entry);
          case "kept":
            return { ...entry, withdrawal: undefined };
        }
      });
  }
}

/** A divider naming an entry is the entry's applied state, whichever source arrived first. */
export function ledgerReducer(ledger: Ledger, event: LedgerEvent): Ledger {
  const next = step(ledger, event);
  return mapEntries(next, (entry) =>
    entry.state !== "gone" && !entry.rendered && next.named.has(entry.id)
      ? { ...advance(entry, "applied"), rendered: true }
      : entry,
  );
}

const settledEntry = (entry: LedgerEntry) =>
  entry.state === "applied" && entry.rendered && entry.snapshotSeen;

/** Entries the writer can still be shown or have their mode overlaid, in order. */
function live(ledger: Ledger): LedgerEntry[] {
  return ledger.entries.filter(
    (entry) => entry.state !== "gone" && entry.withdrawal !== "withdrawing",
  );
}

/**
 * The server keeps one queued switch: a switch to the other mode withdraws it,
 * and a repeat of the same mode changes nothing. Show that before the answer.
 * Only a switch that nothing has answered is predicted, and only against a
 * predecessor the server can still cancel (sending, posted or queued); one the
 * server has listed or answered is its word, and an applied one stays a row.
 */
function foldSwitchBack(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const dropped = new Set<LedgerEntry>();
  let open: LedgerEntry | null = null;
  for (const entry of entries) {
    if (entry.failed) continue;
    const unanswered = entry.state === "sending" || entry.state === "posted";
    // The server can only cancel what it still holds: an applied switch stays its own row.
    const cancellable = open && open.state !== "applied";
    if (open && cancellable && unanswered) {
      if (open.mode !== entry.mode) {
        dropped.add(open);
        dropped.add(entry);
        open = null;
        continue;
      }
      dropped.add(entry);
      continue;
    }
    open = entry;
  }
  return entries.filter((entry) => !dropped.has(entry));
}

/** The entries on screen as rows: not retired by a rendered divider, not predicted away. */
function shown(ledger: Ledger): LedgerEntry[] {
  return foldSwitchBack(
    live(ledger).filter((entry) => !(entry.state === "applied" && entry.rendered)),
  );
}

function rowStatus(entry: LedgerEntry): QueuedControlStatus {
  if (entry.failed) return "failed";
  if (entry.withdrawal === "failed") return "withdraw_failed";
  return entry.state === "sending" || entry.state === "posted" ? "sending" : "queued";
}

export function switchRows(ledger: Ledger): QueuedControl[] {
  return shown(ledger).map((entry) => ({
    id: entry.id,
    control: { kind: "write_mode", mode: entry.mode },
    status: rowStatus(entry),
    ...(entry.awaitingServer && (entry.state === "sending" || entry.state === "posted")
      ? { awaitingServer: true }
      : {}),
  }));
}

/**
 * The chat's mode as the writer should see it: the rendered snapshot's, with
 * each switch not yet settled laid over it, the last one winning. A switch
 * stays laid over after its divider renders until a snapshot holding that
 * divider has been rendered, so the toolbar never reverts to a stale thread.
 */
export function overlaidMode(base: AiWriteMode, ledger: Ledger): AiWriteMode {
  const rows = new Set(shown(ledger));
  let mode = base;
  for (const entry of live(ledger)) {
    if (entry.failed) continue;
    const overlay =
      entry.state === "applied" && entry.rendered ? !entry.snapshotSeen : rows.has(entry);
    if (overlay) mode = entry.mode;
  }
  return mode;
}

/**
 * Whether the ledger holds a switch no live source shows and no fresh snapshot
 * has settled, and the readings that identify the wait. The caller refreshes the
 * snapshot when the key changes.
 */
export function proofKey(ledger: Ledger): string | null {
  const waiting = ledger.entries.filter(
    (entry) =>
      entry.state !== "gone" &&
      !settledEntry(entry) &&
      entry.withdrawal !== "withdrawing" &&
      !entry.inJournal &&
      !entry.inInbox &&
      entry.observedAt > entry.provedAt,
  );
  return waiting.length ? waiting.map((entry) => `${entry.id}@${entry.observedAt}`).join() : null;
}

export type LedgerTransitions = {
  /** Switches that just became visibly queued. */
  queued: AiWriteMode[];
  /** Dividers that just rendered. */
  switched: AiWriteMode[];
  /** A switch applied: the Works defaults and project thread lists are stale. */
  applied: boolean;
};

export function transitions(prev: Ledger, next: Ledger): LedgerTransitions {
  const result: LedgerTransitions = { queued: [], switched: [], applied: false };
  const visible = new Set(shown(next).map((entry) => entry.id));
  for (const entry of next.entries) {
    const before = prev.entries.find((known) => known.id === entry.id);
    if (entry.state === "applied" && before?.state !== "applied") result.applied = true;
    if (
      prev.settled &&
      entry.state === "queued" &&
      before?.state !== "queued" &&
      before?.state !== "applied" &&
      !entry.silent &&
      visible.has(entry.id)
    )
      result.queued.push(entry.mode);
  }
  for (const [turnId, mode] of next.dividers) {
    if (prev.dividers.has(turnId) || !prev.settled) continue;
    result.applied = true;
    result.switched.push(mode);
  }
  return result;
}
