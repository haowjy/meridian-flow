/**
 * Every file this tab is sending, keyed by its intake id, and the one rule for when the writer
 * has taken one back.
 *
 * A Composer chip, a file chip in a document and a picture slot all stand for "a file on its way
 * up". What that node says meanwhile (progress, a failure) is not in any document: it would be
 * undoable there, and outlive its truth. It lives here, with the abort and the `File` a retry
 * sends again. A surface only draws an entry and reports which of its uploads its text still
 * holds (`watch`); this module decides the rest:
 *
 * - out of the text for `GRACE_MS` (an undo, a delete, a cut never pasted back), a sending upload
 *   stops and keeps its file, so a redo can retry;
 * - stopped or failed and out of sight for `KEPT_MS`, the file is let go;
 * - a holder with no surface mounted keeps sending what its text held, because the writer who
 *   opens another document has not asked to stop. What its text no longer held stops at once:
 *   nothing can paste it back into a closed document, and an upload finishing then would leave a
 *   file nothing links to.
 *
 * Module-wide, not per editor, so the timers run whether or not any editor is open.
 *
 * Peers' uploads ride presence (`core/editor/upload-presence.ts`), which reports them here
 * (`reportPeers`): another tab's chip reads "Uploading" from the same place this tab's does.
 */

import { t } from "@lingui/core/macro";

export type UploadState =
  | { kind: "uploading"; percent: number | null }
  | { kind: "failed"; message: string };

/**
 * Sends the file and lands it; whole percents, or null where the browser cannot say how much
 * there is. A rejection is the failure to show, in the writer's words.
 */
export type UploadRun = (
  signal: AbortSignal,
  onProgress: (percent: number | null) => void,
) => Promise<void>;

/** The shape a peer reserves for an upload it watches arrive: a picture's, else null. */
export type UploadFrame = { width: number; height: number };

/** Long enough for a cut and paste inside one document; an undo does not come back. */
const GRACE_MS = 10_000;
/** How long a stopped or failed upload keeps its file for a node that returns to retry. */
const KEPT_MS = 10 * 60_000;

type Waiting = "grace" | "kept";

type Entry = {
  /** Who draws the upload: a document, or a Composer. Its surfaces report what their text holds. */
  holder: string;
  /** Null for a refusal nothing can send again (a folder). */
  run: UploadRun | null;
  state: UploadState;
  controller: AbortController;
  /** Whether the holder's text held it when last asked. */
  present: boolean;
  waiting: Waiting | null;
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/** The ids a mounted surface's text holds now. */
type UploadsPresent = () => ReadonlySet<string>;

export type UploadWatch = {
  /** The holder's text changed: ask again what it holds. */
  changed(): void;
  release(): void;
};

type Listener = (changed: ReadonlySet<string>) => void;

const entries = new Map<string, Entry>();
const watchers = new Map<string, Set<UploadsPresent>>();
const peers = new Map<object, ReadonlyMap<string, UploadFrame | null>>();
const listeners = new Set<Listener>();

function publish(...ids: string[]): void {
  if (ids.length === 0) return;
  const changed = new Set(ids);
  for (const listener of listeners) listener(changed);
}

function waitingFor(entry: Entry): Waiting | "now" | null {
  const mounted = watchers.has(entry.holder);
  if (entry.state.kind === "uploading") return entry.present ? null : mounted ? "grace" : "now";
  return entry.present && mounted ? null : "kept";
}

/** Sets the one timer the take-back rule needs for this entry, keeping its start across changes. */
function arm(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  const next = waitingFor(entry);
  if (next === "now") {
    stop(id);
    return;
  }
  if (next !== entry.waiting) {
    entry.waiting = next;
    entry.since = Date.now();
  }
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  if (next === null) return;
  const wait = entry.since + (next === "grace" ? GRACE_MS : KEPT_MS) - Date.now();
  entry.timer = setTimeout(
    () => {
      entry.timer = null;
      if (entries.get(id) !== entry) return;
      if (next === "grace") stop(id);
      else uploads.discard(id);
    },
    Math.max(0, wait),
  );
}

function setState(id: string, entry: Entry, state: UploadState): void {
  entry.state = state;
  publish(id);
  arm(id);
}

/** Aborts what is in flight and keeps the file: a node that comes back can retry. */
function stop(id: string): void {
  const entry = entries.get(id);
  if (!entry || entry.state.kind === "failed") return;
  entry.controller.abort();
  setState(id, entry, { kind: "failed", message: t`The upload was stopped.` });
}

async function send(id: string, entry: Entry, run: UploadRun): Promise<void> {
  const { controller } = entry;
  const current = () => entries.get(id) === entry && entry.controller === controller;
  try {
    await run(controller.signal, (percent) => {
      if (!current() || entry.state.kind !== "uploading" || entry.state.percent === percent) return;
      entry.state = { kind: "uploading", percent };
      publish(id);
    });
    if (!current()) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entries.delete(id);
    publish(id);
  } catch (error) {
    // An abort is the writer taking the file back, not a failure to report.
    if (controller.signal.aborted || !current()) return;
    const message = error instanceof Error && error.message ? error.message : t`The upload failed.`;
    setState(id, entry, { kind: "failed", message });
  }
}

function settle(holder: string): void {
  const held = [...entries].filter(([, entry]) => entry.holder === holder);
  if (held.length === 0) return;
  const present = new Set<string>();
  for (const read of watchers.get(holder) ?? []) for (const id of read()) present.add(id);
  for (const [id, entry] of held) {
    // An unmounted holder's last answer stands.
    if (watchers.has(holder)) entry.present = present.has(id);
    arm(id);
  }
}

export const uploads = {
  read: (id: string): UploadState | null => entries.get(id)?.state ?? null,

  /** The upload another client says it is sending: its frame, null for none, undefined if nobody is. */
  peerSending(id: string): UploadFrame | null | undefined {
    for (const announced of peers.values()) if (announced.has(id)) return announced.get(id);
    return undefined;
  },

  /** Whether any peer is sending anything, so a text with no upload of its own need not be read. */
  anyPeerSending: (): boolean => peers.size > 0,

  /** Calls back with the ids whose state, or whose peer, changed. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Starts sending. Call it before the node goes into the text, so no node ever draws a gap; the
   * holder's next `changed` sees it there.
   */
  begin(id: string, holder: string, run: UploadRun): void {
    uploads.discard(id);
    const entry: Entry = {
      holder,
      run,
      state: { kind: "uploading", percent: null },
      controller: new AbortController(),
      present: true,
      waiting: null,
      since: 0,
      timer: null,
    };
    entries.set(id, entry);
    publish(id);
    arm(id);
    void send(id, entry, run);
  },

  /** A file refused before any byte left: its node shows why, and nothing can retry it. */
  refuse(id: string, holder: string, message: string): void {
    uploads.discard(id);
    entries.set(id, {
      holder,
      run: null,
      state: { kind: "failed", message },
      controller: new AbortController(),
      present: true,
      waiting: null,
      since: 0,
      timer: null,
    });
    publish(id);
    arm(id);
  },

  /** Sends a stopped or failed upload again, on the same id. */
  retry(id: string): void {
    const entry = entries.get(id);
    if (!entry?.run || entry.state.kind !== "failed") return;
    entry.controller = new AbortController();
    setState(id, entry, { kind: "uploading", percent: null });
    void send(id, entry, entry.run);
  },

  /** Lets go of the file now: nothing will retry this upload. */
  discard(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.controller.abort();
    publish(id);
  },

  /** What `holder` is sending now, which its presence announces. */
  sending(holder: string): string[] {
    return [...entries].flatMap(([id, entry]) =>
      entry.holder === holder && entry.state.kind === "uploading" ? [id] : [],
    );
  },

  /**
   * A surface drawing `holder`'s uploads. `present` is asked only while the holder has any, so a
   * keystroke costs nothing the rest of the time.
   */
  watch(holder: string, present: UploadsPresent): UploadWatch {
    let set = watchers.get(holder);
    if (!set) {
      set = new Set();
      watchers.set(holder, set);
    }
    set.add(present);
    settle(holder);
    return {
      changed: () => settle(holder),
      release() {
        const mounted = watchers.get(holder);
        if (!mounted?.delete(present)) return;
        if (mounted.size === 0) watchers.delete(holder);
        // The text this surface drew is gone; what it last held is the answer now.
        for (const [id, entry] of entries) if (entry.holder === holder) arm(id);
      },
    };
  },

  /** What one room's peers say they are sending; null when the room closes. */
  reportPeers(room: object, announced: ReadonlyMap<string, UploadFrame | null> | null): void {
    const before = peers.get(room);
    if (announced && announced.size > 0) peers.set(room, announced);
    else peers.delete(room);
    publish(...new Set([...(before?.keys() ?? []), ...(announced?.keys() ?? [])]));
  },
};
