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
 * - `gone` comes from a `null`/`null` answer for its own id (cancel-out), a server Withdraw
 *   that answered `withdrawn`, a server 404 for a switch the journal no longer holds (the
 *   server never had it), a local Withdraw the driver allowed, or a snapshot that shows the id
 *   neither pending nor as a divider and whose request began after the entry's watermark.
 *   The server reads turns and inbox in one transaction, so absence in a fresh snapshot is proof.
 * - A cancel-out cannot name the switch it cancelled, so that one is only `predicted`: the
 *   journal entry just before the answered one, of the other mode, still posted or queued.
 *   It is hidden but not terminal; a fresh snapshot lists it (mark cleared) or doesn't
 *   (gone). An answer never touches an entry the journal doesn't hold.
 *
 * A record leaving the journal, or the id leaving the inbox, proves nothing: the entry stays
 * where it was, `proofNeed` turns non-null, and the caller asks for a snapshot. `observedAt`
 * is the highest reading of one counter of snapshot requests started, raised by every source
 * that shows the entry (a snapshot that lists it counts at its `request`); a snapshot proves
 * absence only when `request > observedAt`, so a failed, skipped or joined-older fetch never
 * does. Entries are ordered causally, as a merge of the journal's order and the server's
 * (see `causalOrder`).
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
  /**
   * The order in which this tab's journal first held the entry, counted by the ledger, or
   * `null` for a switch only the server has shown. A record's own `seq` is not it: the journal
   * allocates `seq` above the records it still holds, so a retired record's number is reused.
   */
  held: number | null;
  /** The server's pending-inbox order, once an inbox or snapshot has listed it. */
  serverSeq: number | null;
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
  /**
   * An answer cancelled out the switch before it, and this is that one: hidden from rows and
   * the overlay, but not terminal. A fresh snapshot that lists it clears the mark; one that
   * doesn't settles it gone.
   */
  predicted: boolean;
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
  /** How many entries the journal has held so far: the next entry's `held`. */
  heldCount: number;
  /** Control ids that a rendered divider names. A stale inbox frame cannot revive these. */
  named: ReadonlySet<string>;
  /** Rendered divider turn ids, with the mode each switched to. */
  dividers: ReadonlyMap<string, AiWriteMode>;
  /** Where the transcript places the divider that names a control id. */
  positions: ReadonlyMap<string, number>;
  /** History and the first projection are in; what arrives after is news. */
  settled: boolean;
};

export const EMPTY_LEDGER: Ledger = {
  entries: [],
  heldCount: 0,
  named: new Set(),
  dividers: new Map(),
  positions: new Map(),
  settled: false,
};

export type JournalRecord = {
  id: string;
  mode: AiWriteMode;
  /** The journal's order among the records it holds now; not comparable with a retired record's. */
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

/** Where the server has put an entry: its divider in the transcript, else its place in the inbox. */
function serverPlace(entry: LedgerEntry, positions: ReadonlyMap<string, number>): number[] | null {
  const position = positions.get(entry.id);
  if (position !== undefined) return [0, position];
  return entry.serverSeq === null ? null : [1, entry.serverSeq];
}

const byId = (a: LedgerEntry, b: LedgerEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The chat's causal order, a merge of the two chains the sources give:
 *
 * - the journal chain: entries this tab's journal has held, in the order it first held them
 *   (this tab's known happens-before);
 * - the server chain: entries the server has placed (a divider's transcript position, else
 *   its inbox order).
 *
 * An entry on both chains anchors them together, so neither chain's order is ever reversed
 * by what the other holds: lifecycle state moves nothing. Where the chains disagree about
 * two anchors the journal wins. Between two entries no anchor relates, an applied entry
 * with no divider yet goes before what the server still holds queued (the server consumed it
 * first), and everything else the server holds goes before what only the journal knows.
 */
function causalOrder(
  entries: readonly LedgerEntry[],
  positions: ReadonlyMap<string, number>,
): LedgerEntry[] {
  const place = new Map(entries.map((entry) => [entry, serverPlace(entry, positions)] as const));
  const journal = entries
    .filter((e) => e.held !== null)
    .sort((a, b) => (a.held ?? 0) - (b.held ?? 0) || byId(a, b));
  const server = entries
    .filter((e) => place.get(e))
    .sort((a, b) => {
      const [pa, pb] = [place.get(a) as number[], place.get(b) as number[]];
      return (pa[0] ?? 0) - (pb[0] ?? 0) || (pa[1] ?? 0) - (pb[1] ?? 0) || byId(a, b);
    });
  const onJournal = new Set(journal);
  const onServer = new Set(server);
  const out: LedgerEntry[] = [];
  const placed = new Set<LedgerEntry>();
  let j = 0;
  let s = 0;
  while (j < journal.length || s < server.length) {
    const jh = journal[j];
    const sh = server[s];
    if (jh && placed.has(jh)) j += 1;
    else if (sh && placed.has(sh)) s += 1;
    else {
      let take: LedgerEntry;
      if (!sh) take = jh as LedgerEntry;
      else if (!jh || jh === sh) take = sh;
      else if (onServer.has(jh) && !onJournal.has(sh)) take = sh;
      else if (onJournal.has(sh) && !onServer.has(jh)) take = jh;
      else if (onServer.has(jh)) take = jh;
      else take = jh.state === "applied" && place.get(sh)?.[0] === 1 ? jh : sh;
      out.push(take);
      placed.add(take);
    }
  }
  const unplaced = entries.filter((entry) => !placed.has(entry)).sort(byId);
  return [...out, ...unplaced];
}

function sorted(ledger: Ledger): Ledger {
  const entries = causalOrder(ledger.entries, ledger.positions);
  return entries.some((entry, index) => entry !== ledger.entries[index])
    ? { ...ledger, entries }
    : ledger;
}

function advance(entry: LedgerEntry, state: LedgerState): LedgerEntry {
  if (entry.state === "gone" || RANK[state] <= RANK[entry.state]) return entry;
  return {
    ...entry,
    state,
    failed: RANK[state] > RANK.posted ? false : entry.failed,
    predicted: RANK[state] >= RANK.applied ? false : entry.predicted,
  };
}

function blank(id: string, mode: AiWriteMode, at: number, state: LedgerState): LedgerEntry {
  return {
    id,
    mode,
    held: null,
    serverSeq: null,
    state,
    failed: false,
    awaitingServer: false,
    inJournal: false,
    inInbox: false,
    observedAt: at,
    provedAt: 0,
    predicted: false,
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
  return { ...ledger, entries };
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
    : { ...entry, state: "gone", failed: false, predicted: false, withdrawal: undefined };

function step(ledger: Ledger, event: LedgerEvent): Ledger {
  switch (event.type) {
    case "journal": {
      let next = ledger;
      let heldCount = ledger.heldCount;
      const held = new Set(event.records.map((record) => record.id));
      const inOrder = [...event.records].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
      for (const record of inOrder) {
        const state: LedgerState = next.named.has(record.id)
          ? "applied"
          : record.posted
            ? "posted"
            : "sending";
        next = upsert(next, record.id, record.mode, event.at, state, (entry) => {
          const advanced = advance(entry, state);
          return {
            ...advanced,
            held: advanced.held ?? heldCount++,
            inJournal: true,
            observedAt: raise(advanced, event.at),
            failed: RANK[advanced.state] <= RANK.posted && record.failed,
            awaitingServer: record.posted && !record.refused,
          };
        });
      }
      next = { ...next, heldCount };
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
      const next = upsert(
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
      // The answer is evidence about its own id. The switch the server cancelled is the one
      // this tab's journal ordered just before it, when that one is still held; the answer
      // never lists ids, so anything else stays until a snapshot says otherwise.
      const own = next.entries.find((entry) => entry.id === event.id);
      if (own?.held == null) return next;
      const ownHeld = own.held;
      let before: LedgerEntry | null = null;
      for (const entry of next.entries) {
        if (entry.held === null || entry.held >= ownHeld || entry.state === "gone") continue;
        if (!before || entry.held > (before.held ?? 0)) before = entry;
      }
      const target = before;
      if (
        !target ||
        target.mode === event.mode ||
        target.failed ||
        (target.state !== "posted" && target.state !== "queued")
      )
        return next;
      return patch(next, target.id, (entry) => ({
        ...entry,
        predicted: true,
        observedAt: raise(entry, event.at),
      }));
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
      const positions = new Map(next.positions);
      event.dividers.forEach((divider, index) => {
        if (divider.controlId && !positions.has(divider.controlId))
          positions.set(divider.controlId, index);
      });
      next = { ...next, positions };
      return mapEntries(next, (entry) => {
        if (entry.state === "gone") return entry;
        // A snapshot that shows the entry is a reading of it at its request.
        const shows = {
          observedAt: raise(entry, event.request),
          provedAt: Math.max(entry.provedAt, event.request),
        };
        if (named.has(entry.id))
          return { ...advance(entry, "applied"), ...shows, snapshotSeen: true };
        if (entry.predicted) {
          if (event.request <= entry.observedAt) return entry;
          return listed.has(entry.id) ? { ...entry, ...shows, predicted: false } : gone(entry);
        }
        if (listed.has(entry.id)) return { ...entry, ...shows };
        const sourced = entry.inJournal || entry.inInbox;
        return !sourced && event.request > entry.observedAt ? gone(entry) : entry;
      });
    }
    case "transcript": {
      if (event.dividers.every((divider) => ledger.dividers.has(divider.turnId))) return ledger;
      const dividers = new Map(ledger.dividers);
      const named = new Set(ledger.named);
      const positions = new Map(ledger.positions);
      event.dividers.forEach((divider, index) => {
        dividers.set(divider.turnId, divider.mode);
        if (divider.controlId) {
          named.add(divider.controlId);
          positions.set(divider.controlId, index);
        }
      });
      return { ...ledger, dividers, named, positions };
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
  return sorted(
    mapEntries(next, (entry) =>
      entry.state !== "gone" && !entry.rendered && next.named.has(entry.id)
        ? { ...advance(entry, "applied"), rendered: true }
        : entry,
    ),
  );
}

const settledEntry = (entry: LedgerEntry) =>
  entry.state === "applied" && entry.rendered && entry.snapshotSeen;

/** Entries the writer can still be shown or have their mode overlaid, in order. */
function live(ledger: Ledger): LedgerEntry[] {
  return ledger.entries.filter(
    (entry) => entry.state !== "gone" && !entry.predicted && entry.withdrawal !== "withdrawing",
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
 * The bar for settling what the ledger waits on: a switch no live source shows (or a
 * cancel-out only predicted) is settled by a snapshot whose request began above the highest
 * reading at which any of them was seen. Null when the ledger waits on nothing.
 */
export function proofNeed(ledger: Ledger): number | null {
  const waiting = ledger.entries.filter(
    (entry) =>
      entry.state !== "gone" &&
      !settledEntry(entry) &&
      entry.withdrawal !== "withdrawing" &&
      (entry.predicted ||
        (!entry.inJournal && !entry.inInbox && entry.observedAt > entry.provedAt)),
  );
  return waiting.length ? Math.max(...waiting.map((entry) => entry.observedAt)) : null;
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
