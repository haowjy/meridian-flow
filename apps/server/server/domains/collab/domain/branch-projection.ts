/**
 * The projection job (design §3.2): a work draft's `has_effect`, its watermark and its Work's
 * touch, derived from the published replica after an append commits, never on the keystroke.
 * Marked dirty by every committed append, coalesced per branch, run at most `maxRuns` at a time,
 * retried on backoff, and repaired by a finite sweep over the persisted stale set. Process-local:
 * two processes judging one branch at one revision write the same value twice.
 */
import { bytesEqual } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchPullService } from "./branch-pulls.js";
import { BranchMissingError, type BranchStore, type StaleEffectCursor } from "./branch-store.js";
import type { WriterFrameDiagnostics } from "./branch-writer-frames.js";
import {
  type EffectFingerprint,
  effectFingerprint,
  effectFingerprintsEqual,
} from "./document-content.js";

/** A pause runs the job this long after the last key... */
const DEBOUNCE_MS = 250;
/** ...and continuous typing within this long of the first unserved key. */
const MAX_WAIT_MS = 1_000;
const BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const MAX_RUNS = 4;
const SWEEP_PAGE = 50;

export type BranchProjection = {
  /** A committed append made the branch's derived state stale. */
  markDirty(branchId: string): void;
  /** One finite pass over the stale set; returns how many branches it newly tracked. */
  sweep(): Promise<number>;
  /** Clears every timer; runs in flight finish and re-arm nothing. */
  dispose(): void;
};

type Outcome = "done" | "drop" | "moved" | "contended" | "fenced" | "parked";

type Entry = {
  firstDirtyAt?: number;
  lastDirtyAt?: number;
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

export function createBranchProjection(input: {
  coordinator: Pick<BranchCoordinator, "readBranch">;
  store: Pick<BranchStore, "readEffectBaseline" | "writeEffect" | "staleEffectBranches">;
  pulls: Pick<BranchPullService, "pullWorkDraft">;
  diagnostics?: Pick<WriterFrameDiagnostics, "projectionFailed" | "projectionBaselineBlocked">;
  /** Runs a body outside every ambient transaction and write grant. */
  outsideTransaction<T>(operation: () => T): T;
  maxRuns?: number;
}): BranchProjection {
  const maxRuns = input.maxRuns ?? MAX_RUNS;
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  const baselines = new Map<string, { state: Uint8Array; fingerprint: EffectFingerprint }>();
  const diagnosedBlocked = new Set<string>();
  let running = 0;
  let sweeping = false;
  let disposed = false;

  function entryOf(branchId: string): Entry {
    let entry = entries.get(branchId);
    if (!entry) {
      entry = { running: false, queued: false, again: false, failures: 0, parked: false };
      entries.set(branchId, entry);
    }
    return entry;
  }

  function arm(branchId: string, entry: Entry, delayMs: number): void {
    if (disposed) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        enqueue(branchId, entry);
      },
      Math.max(0, delayMs),
    );
    entry.timer.unref();
  }

  function markDirty(branchId: string): void {
    if (disposed) return;
    const entry = entryOf(branchId);
    entry.parked = false;
    if (entry.running) {
      entry.again = true;
      return;
    }
    if (entry.queued) return;
    const now = Date.now();
    entry.lastDirtyAt = now;
    entry.firstDirtyAt ??= now;
    arm(branchId, entry, Math.min(now + DEBOUNCE_MS, entry.firstDirtyAt + MAX_WAIT_MS) - now);
  }

  function enqueue(branchId: string, entry: Entry): void {
    if (disposed || entry.running || entry.queued) return;
    if (running < maxRuns) start(branchId, entry);
    else {
      entry.queued = true;
      queue.push(branchId);
    }
  }

  function start(branchId: string, entry: Entry): void {
    running += 1;
    entry.running = true;
    entry.again = false;
    entry.firstDirtyAt = undefined;
    entry.lastDirtyAt = undefined;
    void input
      .outsideTransaction(() => judge(branchId))
      .catch((cause: unknown): "failed" => {
        input.diagnostics?.projectionFailed({ branchId, cause });
        return "failed";
      })
      .then((outcome) => settle(branchId, entry, outcome))
      .finally(() => {
        running -= 1;
        next();
      });
  }

  function next(): void {
    while (running < maxRuns && queue.length) {
      const branchId = queue.shift() as string;
      const entry = entries.get(branchId);
      if (!entry) continue;
      entry.queued = false;
      start(branchId, entry);
    }
  }

  function settle(branchId: string, entry: Entry, outcome: Outcome | "failed"): void {
    entry.running = false;
    if (outcome === "drop") {
      entries.delete(branchId);
      baselines.delete(branchId);
      return;
    }
    if (outcome === "done" || outcome === "moved") entry.failures = 0;
    else if (outcome !== "parked") entry.failures += 1;
    if (outcome === "parked") entry.parked = true;
    // A mark that landed during the run is served whatever the run decided.
    if (entry.again || outcome === "moved") {
      entry.again = false;
      entry.parked = false;
      markDirty(branchId);
      return;
    }
    if (outcome === "done") {
      entries.delete(branchId);
      return;
    }
    if (outcome === "parked") return;
    arm(branchId, entry, Math.min(BACKOFF_MS * 2 ** (entry.failures - 1), MAX_BACKOFF_MS));
  }

  /** One judgement of the branch at its published revision, and its write. */
  async function judge(branchId: string): Promise<Outcome> {
    let judged:
      | { kind: "done" }
      | {
          kind: "legacy";
          documentId: Parameters<BranchPullService["pullWorkDraft"]>[0]["documentId"];
        }
      | {
          kind: "judged";
          write: Parameters<BranchStore["writeEffect"]>[0];
        };
    try {
      judged = await input.coordinator.readBranch(branchId, async (doc, snapshot) => {
        // A thread peer carries no effect; a closed branch is not a review member.
        if (snapshot.kind !== "work_draft" || snapshot.status !== "active")
          return { kind: "done" as const };
        const draft = effectFingerprint(doc);
        const baseline = await input.store.readEffectBaseline(branchId);
        if (!baseline) return { kind: "done" as const };
        if (!baseline.state) return { kind: "legacy" as const, documentId: snapshot.documentId };
        return {
          kind: "judged" as const,
          write: {
            branchId,
            revision: snapshot.revision,
            hasEffect: !effectFingerprintsEqual(
              baselineFingerprint(branchId, baseline.state),
              draft,
            ),
            workId: snapshot.workId,
          },
        };
      });
    } catch (cause) {
      if (cause instanceof BranchMissingError) return "drop";
      throw cause;
    }
    if (judged.kind === "done") return "done";
    if (judged.kind === "legacy") {
      // A legacy row's baseline is live's current state, established by the branch-scoped
      // exact pull, which writes `live_cut`, `has_effect` and the watermark itself.
      const pulled = await input.pulls.pullWorkDraft({ documentId: judged.documentId, branchId });
      if (pulled === "pulled" || pulled === "upstreamMoved") return "done";
      if (pulled === "closed") return "drop";
      if (pulled === "fenced") return "fenced";
      if (!diagnosedBlocked.has(branchId)) {
        diagnosedBlocked.add(branchId);
        input.diagnostics?.projectionBaselineBlocked({ branchId, documentId: judged.documentId });
      }
      return "parked";
    }
    const written = await input.store.writeEffect(judged.write);
    return written === "written" ? "done" : written;
  }

  function baselineFingerprint(branchId: string, state: Uint8Array): EffectFingerprint {
    const cached = baselines.get(branchId);
    if (cached && bytesEqual(cached.state, state)) return cached.fingerprint;
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, state);
      const fingerprint = effectFingerprint(doc);
      baselines.set(branchId, { state, fingerprint });
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
          const page = await input.store.staleEffectBranches({
            ...(after ? { after } : {}),
            limit: SWEEP_PAGE,
          });
          for (const { branchId } of page) {
            // Already dirty, running, backing off, queued or parked: left to its own entry.
            if (entries.has(branchId)) continue;
            markDirty(branchId);
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

    dispose() {
      disposed = true;
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      queue.length = 0;
    },
  };
}
