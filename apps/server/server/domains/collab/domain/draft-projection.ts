/**
 * The projection job (design §3.2): a work draft's `has_effect`, its watermark and its Work's
 * touch, derived from the committed replica after an append commits, never on the keystroke.
 * Marked dirty by every committed append, coalesced per branch, run at most `maxRuns` at a time,
 * retried on backoff, and repaired by a finite sweep over the persisted stale set. Process-local:
 * two processes judging one branch at one revision write the same value twice.
 *
 * The stored value converges within the max wait once typing pauses, and eventually while typing
 * (D34): a write guarded by the revision it judged misses whenever a key commits during the run,
 * so a `moved` write re-judges at once rather than on the debounce. Only errors back off.
 */
import { bytesEqual } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  type EffectFingerprint,
  effectFingerprint,
  effectFingerprintsEqual,
} from "./document-content.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftPullService } from "./draft-pulls.js";
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
  /** A committed append made the branch's derived state stale. */
  markDirty(draftId: string): void;
  /** One finite pass over the stale set; returns how many drafts it newly tracked. */
  sweep(): Promise<number>;
  /**
   * Runs every pending judgement now, skipping its debounce or backoff, and resolves once
   * none is pending or running (a parked one excepted): the convergence point for a reader
   * that must see the projection caught up, such as a test asserting review membership.
   */
  flush(): Promise<void>;
  /** Clears every timer; runs in flight finish and re-arm nothing. */
  dispose(): void;
};

export type DraftProjectionDiagnostics = {
  /** A projection run failed; the branch is retried on its backoff and never dropped. */
  projectionFailed(input: { draftId: string; cause: unknown }): void;
  /**
   * A legacy branch's baseline cannot be established: its document has a terminally blocked
   * settlement. Once per process; the branch waits for its next append or a restart.
   */
  projectionBaselineBlocked(input: { draftId: string; documentId: string }): void;
};

type Outcome = "done" | "drop" | "moved" | "contended" | "fenced" | "parked";

type Entry = {
  firstDirtyAt?: number;
  timer?: NodeJS.Timeout;
  running: boolean;
  queued: boolean;
  /** Marked while running: run again once it finishes. */
  again: boolean;
  /** Consecutive unwritten attempts, for the backoff. */
  failures: number;
  /** A terminally blocked legacy baseline: no timer until the next append or a restart. */
  parked: boolean;
};

export function createDraftProjection(input: {
  coordinator: Pick<DraftCoordinator, "readDraft">;
  store: Pick<DraftStore, "readEffectBaseline" | "writeEffect" | "staleEffectDrafts">;
  pulls: Pick<DraftPullService, "pullWorkDraft">;
  diagnostics?: DraftProjectionDiagnostics;
  /** Runs a body outside every ambient transaction and write grant. */
  outsideTransaction<T>(operation: () => T): T;
  maxRuns?: number;
}): DraftProjection {
  const maxRuns = input.maxRuns ?? MAX_RUNS;
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  const baselines = new Map<string, { state: Uint8Array; fingerprint: EffectFingerprint }>();
  const diagnosedBlocked = new Set<string>();
  let running = 0;
  let sweeping = false;
  let disposed = false;

  function entryOf(draftId: string): Entry {
    let entry = entries.get(draftId);
    if (!entry) {
      entry = { running: false, queued: false, again: false, failures: 0, parked: false };
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
    entry.parked = false;
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
      baselines.delete(draftId);
      return;
    }
    if (outcome === "done" || outcome === "moved") entry.failures = 0;
    else if (outcome !== "parked") entry.failures += 1;
    if (outcome === "parked") entry.parked = true;
    // A key committed between the judgement and its guarded write: judge the new revision now.
    if (outcome === "moved") {
      entry.again = false;
      entry.parked = false;
      enqueue(draftId, entry);
      return;
    }
    // A mark that landed during the run is served whatever the run decided.
    if (entry.again) {
      entry.again = false;
      entry.parked = false;
      markDirty(draftId);
      return;
    }
    if (outcome === "done") {
      entries.delete(draftId);
      return;
    }
    if (outcome === "parked") return;
    arm(draftId, entry, Math.min(BACKOFF_MS * 2 ** (entry.failures - 1), MAX_BACKOFF_MS));
  }

  /** One judgement of the branch at its committed revision, and its write. */
  async function judge(draftId: string): Promise<Outcome> {
    let judged:
      | { kind: "done" }
      | {
          kind: "legacy";
          documentId: Parameters<DraftPullService["pullWorkDraft"]>[0]["documentId"];
        }
      | {
          kind: "judged";
          write: Parameters<DraftStore["writeEffect"]>[0];
        };
    try {
      judged = await input.coordinator.readDraft(draftId, async (doc, snapshot) => {
        // A thread peer carries no effect; a closed branch is not a review member.
        if (snapshot.kind !== "work_draft" || snapshot.status !== "active")
          return { kind: "done" as const };
        const draft = effectFingerprint(doc);
        const baseline = await input.store.readEffectBaseline(draftId);
        if (!baseline) return { kind: "done" as const };
        if (!baseline.state) return { kind: "legacy" as const, documentId: snapshot.documentId };
        return {
          kind: "judged" as const,
          write: {
            draftId,
            revision: snapshot.revision,
            hasEffect: !effectFingerprintsEqual(
              baselineFingerprint(draftId, baseline.state),
              draft,
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
    if (judged.kind === "legacy") {
      // A legacy row's baseline is live's current state, established by the branch-scoped
      // exact pull, which writes `live_cut`, `has_effect` and the watermark itself.
      const pulled = await input.pulls.pullWorkDraft({ documentId: judged.documentId, draftId });
      if (pulled === "pulled" || pulled === "upstreamMoved") return "done";
      if (pulled === "closed") return "drop";
      if (pulled === "fenced") return "fenced";
      if (!diagnosedBlocked.has(draftId)) {
        diagnosedBlocked.add(draftId);
        input.diagnostics?.projectionBaselineBlocked({ draftId, documentId: judged.documentId });
      }
      return "parked";
    }
    const written = await input.store.writeEffect(judged.write);
    return written === "written" ? "done" : written;
  }

  function baselineFingerprint(draftId: string, state: Uint8Array): EffectFingerprint {
    const cached = baselines.get(draftId);
    if (cached && bytesEqual(cached.state, state)) return cached.fingerprint;
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, state);
      const fingerprint = effectFingerprint(doc);
      baselines.set(draftId, { state, fingerprint });
      return fingerprint;
    } finally {
      doc.destroy();
    }
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
            // Already dirty, running, backing off, queued or parked: left to its own entry.
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
          if (entry.parked) continue;
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
      throw new Error("The branch effect projection did not settle");
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      queue.length = 0;
    },
  };
}
