import { t } from "@lingui/core/macro";

export type UploadState =
  | { kind: "uploading"; percent: number | null }
  | { kind: "failed"; message: string };

export type UploadRun = (
  signal: AbortSignal,
  onProgress: (percent: number | null) => void,
) => Promise<void>;

export type UploadFrame = { width: number; height: number };

const GRACE_MS = 10_000;
const KEPT_MS = 10 * 60_000;

type Waiting = "grace" | "kept";

type Entry = {
  holder: string;
  run: UploadRun | null;
  state: UploadState;
  controller: AbortController;
  held: boolean;
  waiting: Waiting | null;
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type UploadsPresent = () => ReadonlySet<string>;

type Watcher = { holder: string; read: UploadsPresent; last: ReadonlySet<string> };

export type UploadWatch = {
  changed(): void;
  release(): void;
};

type Listener = (changed: ReadonlySet<string>) => void;

const entries = new Map<string, Entry>();
const watchers = new Set<Watcher>();
const NOTHING: ReadonlySet<string> = new Set();
const peers = new Map<object, ReadonlyMap<string, UploadFrame | null>>();
const listeners = new Set<Listener>();

function publish(...ids: string[]): void {
  if (ids.length === 0) return;
  const changed = new Set(ids);
  for (const listener of listeners) listener(changed);
}

function mounted(holder: string): boolean {
  for (const watcher of watchers) if (watcher.holder === holder) return true;
  return false;
}

function waitingFor(id: string, entry: Entry): Waiting | "now" | null {
  let shown = false;
  for (const watcher of watchers) if (watcher.last.has(id)) shown = true;
  if (entry.state.kind !== "uploading") return shown ? null : "kept";
  if (shown) return null;
  if (mounted(entry.holder)) return "grace";
  return entry.held ? null : "now";
}

function arm(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  const next = waitingFor(id, entry);
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

function stop(id: string): void {
  const entry = entries.get(id);
  if (!entry || entry.state.kind === "failed") return;
  entry.controller.abort();
  setState(id, entry, { kind: "failed", message: t`The upload was stopped.` });
}

async function send(id: string, entry: Entry, run: UploadRun): Promise<void> {
  const { controller } = entry;
  // A stopped run is over even if its finish lands: the entry is the stop's, or a retry's.
  const current = () =>
    entries.get(id) === entry && entry.controller === controller && !controller.signal.aborted;
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
    if (controller.signal.aborted || !current()) return;
    const message = error instanceof Error && error.message ? error.message : t`The upload failed.`;
    setState(id, entry, { kind: "failed", message });
  }
}

function settle(watcher: Watcher): void {
  if (entries.size === 0) {
    watcher.last = NOTHING;
    return;
  }
  watcher.last = watcher.read();
  const held = new Set<string>();
  for (const other of watchers) {
    if (other.holder !== watcher.holder) continue;
    for (const id of other.last) held.add(id);
  }
  for (const [id, entry] of entries) {
    if (entry.holder === watcher.holder) entry.held = held.has(id);
    arm(id);
  }
}

export const uploads = {
  read: (id: string): UploadState | null => entries.get(id)?.state ?? null,

  peerSending(id: string): UploadFrame | null | undefined {
    for (const announced of peers.values()) if (announced.has(id)) return announced.get(id);
    return undefined;
  },

  of(id: string): UploadState | null {
    return (
      uploads.read(id) ??
      (uploads.peerSending(id) === undefined ? null : { kind: "uploading", percent: null })
    );
  },

  anyPeerSending: (): boolean => peers.size > 0,

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
      held: true,
      waiting: null,
      since: 0,
      timer: null,
    };
    entries.set(id, entry);
    publish(id);
    arm(id);
    void send(id, entry, run);
  },

  refuse(id: string, holder: string, message: string): void {
    uploads.discard(id);
    entries.set(id, {
      holder,
      run: null,
      state: { kind: "failed", message },
      controller: new AbortController(),
      held: true,
      waiting: null,
      since: 0,
      timer: null,
    });
    publish(id);
    arm(id);
  },

  retry(id: string): void {
    const entry = entries.get(id);
    if (!entry?.run || entry.state.kind !== "failed") return;
    entry.controller = new AbortController();
    setState(id, entry, { kind: "uploading", percent: null });
    void send(id, entry, entry.run);
  },

  discard(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.controller.abort();
    publish(id);
  },

  discardHeld(holder: string): void {
    for (const [id, entry] of entries) if (entry.holder === holder) uploads.discard(id);
  },

  sending(holder: string): string[] {
    return [...entries].flatMap(([id, entry]) =>
      entry.holder === holder && entry.state.kind === "uploading" ? [id] : [],
    );
  },

  watch(holder: string, present: UploadsPresent): UploadWatch {
    const watcher: Watcher = { holder, read: present, last: NOTHING };
    watchers.add(watcher);
    settle(watcher);
    return {
      changed: () => {
        if (watchers.has(watcher)) settle(watcher);
      },
      release() {
        if (!watchers.delete(watcher)) return;
        for (const id of entries.keys()) arm(id);
      },
    };
  },

  reportPeers(room: object, announced: ReadonlyMap<string, UploadFrame | null> | null): void {
    const before = peers.get(room);
    if (announced && announced.size > 0) peers.set(room, announced);
    else peers.delete(room);
    publish(...new Set([...(before?.keys() ?? []), ...(announced?.keys() ?? [])]));
  },
};
