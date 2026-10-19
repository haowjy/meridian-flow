/**
 * The projection job (design §3.2): a work draft's `has_effect`, its watermark and its Work's
 * touch, derived from the committed replica after an append commits, never on the keystroke.
 * Marked dirty by every committed append, coalesced per draft, run at most `maxRuns` at a time,
 * retried on backoff, and repaired by a finite sweep over the persisted stale set. Process-local:
 * two processes judging one draft at one revision write the same value twice.
 *
 * The stored value converges within the max wait once typing pauses, and eventually while typing
 * (D34): a write guarded by the revision it judged misses whenever a key commits during the run,
 * so a `moved` write re-judges at once rather than on the debounce. Only errors back off.
 */
import { blocksEqual, REVIEW_BASE_FRAGMENT, readBlocks } from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { DraftCoordinator } from "./draft-coordinator.js";
import { DraftMissingError, type DraftStore, type StaleEffectCursor } from "./draft-store.js";

/** A pause runs the job this long after the last key... */
const DEBOUNCE_MS = 250;
/** ...and continuous typing starts a run within this long of the first unserved key. */
const MAX_WAIT_MS = 1_000;
const BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const MAX_RUNS = 4;
const SWEEP_PAGE = 50;

export type DraftProjection = {
  /** A committed append made the draft's derived state stale. */
  markDirty(draftId: string): void;
  /** One finite pass over the stale set; returns how many drafts it newly tracked. */
  sweep(): Promise<number>;
  /**
   * Runs every pending judgement now, skipping its debounce or backoff, and resolves once
   * none is pending or running: the convergence point for a reader
   * that must see the projection caught up, such as a test asserting review membership.
   */
  flush(): Promise<void>;
  /** Clears every timer; runs in flight finish and re-arm nothing. */
  dispose(): void;
};

export type DraftProjectionDiagnostics = {
  /** A projection run failed; the draft is retried on its backoff and never dropped. */
  projectionFailed(input: { draftId: string; cause: unknown }): void;
};

type Outcome = "done" | "drop" | "moved" | "contended";

type Entry = {
  firstDirtyAt?: number;
  timer?: NodeJS.Timeout;
  running: boolean;
  queued: boolean;
  /** Marked while running: run again once it finishes. */
  again: boolean;
  /** Consecutive unwritten attempts, for the backoff. */
  failures: number;
};

export function createDraftProjection(input: {
  coordinator: Pick<DraftCoordinator, "readDraft">;
  store: Pick<DraftStore, "writeEffect" | "staleEffectDrafts">;
  diagnostics?: DraftProjectionDiagnostics;
  /** Runs a body outside every ambient transaction and write grant. */
  outsideTransaction<T>(operation: () => T): T;
  maxRuns?: number;
}): DraftProjection {
  const maxRuns = input.maxRuns ?? MAX_RUNS;
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  const schema = buildDocumentSchema();
  let running = 0;
  let sweeping = false;
  let disposed = false;

  function entryOf(draftId: string): Entry {
    let entry = entries.get(draftId);
    if (!entry) {
      entry = { running: false, queued: false, again: false, failures: 0 };
      entries.set(draftId, entry);
    }
    return entry;
  }

  function arm(draftId: string, entry: Entry, delayMs: number): void {
    if (disposed) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        enqueue(draftId, entry);
      },
      Math.max(0, delayMs),
    );
    entry.timer.unref();
  }

  function markDirty(draftId: string): void {
    if (disposed) return;
    const entry = entryOf(draftId);
    if (entry.running) {
      entry.again = true;
      return;
    }
    if (entry.queued) return;
    const now = Date.now();
    entry.firstDirtyAt ??= now;
    arm(draftId, entry, Math.min(now + DEBOUNCE_MS, entry.firstDirtyAt + MAX_WAIT_MS) - now);
  }

  function enqueue(draftId: string, entry: Entry): void {
    if (disposed || entry.running || entry.queued) return;
    if (running < maxRuns) start(draftId, entry);
    else {
      entry.queued = true;
      queue.push(draftId);
    }
  }

  function start(draftId: string, entry: Entry): void {
    running += 1;
    entry.running = true;
    entry.again = false;
    entry.firstDirtyAt = undefined;
    void input
      .outsideTransaction(() => judge(draftId))
      .catch((cause: unknown): "failed" => {
        input.diagnostics?.projectionFailed({ draftId, cause });
        return "failed";
      })
      .then((outcome) => settle(draftId, entry, outcome))
      .finally(() => {
        running -= 1;
        next();
      });
  }

  function next(): void {
    while (running < maxRuns && queue.length) {
      const draftId = queue.shift() as string;
      const entry = entries.get(draftId);
      if (!entry) continue;
      entry.queued = false;
      start(draftId, entry);
    }
  }

  function settle(draftId: string, entry: Entry, outcome: Outcome | "failed"): void {
    entry.running = false;
    if (outcome === "drop") {
      entries.delete(draftId);
      return;
    }
    if (outcome === "done" || outcome === "moved") entry.failures = 0;
    else entry.failures += 1;
    // A key committed between the judgement and its guarded write: judge the new revision now.
    if (outcome === "moved") {
      entry.again = false;
      enqueue(draftId, entry);
      return;
    }
    // A mark that landed during the run is served whatever the run decided.
    if (entry.again) {
      entry.again = false;
      markDirty(draftId);
      return;
    }
    if (outcome === "done") {
      entries.delete(draftId);
      return;
    }
    arm(draftId, entry, Math.min(BACKOFF_MS * 2 ** (entry.failures - 1), MAX_BACKOFF_MS));
  }

  /** One judgement of the draft at its committed revision, and its write. */
  async function judge(draftId: string): Promise<Outcome> {
    let judged:
      | { kind: "done" }
      | { kind: "judged"; write: Parameters<DraftStore["writeEffect"]>[0] };
    try {
      judged = await input.coordinator.readDraft(draftId, async (doc, snapshot) => {
        // A thread peer carries no effect; a closed draft is not a review member.
        if (snapshot.kind !== "work_draft" || snapshot.status !== "active")
          return { kind: "done" as const };
        return {
          kind: "judged" as const,
          write: {
            draftId,
            revision: snapshot.revision,
            hasEffect: !blocksEqual(
              readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
              readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
            ),
            workId: snapshot.workId,
          },
        };
      });
    } catch (cause) {
      if (cause instanceof DraftMissingError) return "drop";
      throw cause;
    }
    if (judged.kind === "done") return "done";
    const written = await input.store.writeEffect(judged.write);
    return written === "written" ? "done" : written;
  }

  return {
    markDirty,

    async sweep() {
      if (sweeping || disposed) return 0;
      sweeping = true;
      let tracked = 0;
      try {
        let after: StaleEffectCursor | undefined;
        for (;;) {
          const page = await input.store.staleEffectDrafts({
            ...(after ? { after } : {}),
            limit: SWEEP_PAGE,
          });
          for (const { draftId } of page) {
            // Already dirty, running, backing off or queued: left to its own entry.
            if (entries.has(draftId)) continue;
            markDirty(draftId);
            tracked += 1;
          }
          after = page.at(-1);
          if (page.length < SWEEP_PAGE) break;
        }
      } finally {
        sweeping = false;
      }
      return tracked;
    },

    async flush() {
      for (let round = 0; round < 1_000; round += 1) {
        let pending = running > 0 || queue.length > 0;
        for (const [draftId, entry] of entries) {
          pending = true;
          if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
            enqueue(draftId, entry);
          }
        }
        if (!pending || disposed) return;
        await new Promise((done) => setTimeout(done, 2));
      }
      throw new Error("The draft effect projection did not settle");
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      queue.length = 0;
    },
  };
}
