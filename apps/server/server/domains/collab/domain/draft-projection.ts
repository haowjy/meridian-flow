/**
 * The projection job (design §3.2): a work draft's `has_effect` and `text_changes`, its watermark and its Work's
 * touch, derived from the committed replica after an append commits, never on the keystroke.
 * Marked dirty by every committed append, coalesced per draft, run at most `maxRuns` at a time,
 * retried on backoff, and repaired by a finite sweep over the persisted stale set. Process-local:
 * two processes judging one draft at one revision write the same value twice.
 *
 * The stored value converges within the max wait once typing pauses, and eventually while typing
 *: a write guarded by the revision it judged misses whenever a key commits during the run,
 * so a `moved` write re-judges at once rather than on the debounce. Only errors back off.
 */
import {
  blocksEqual,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import { createKeyedCoalescer } from "../../../shared/keyed-coalescer.js";
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

const schema = buildDocumentSchema();

/** The one judgement of `has_effect`: the draft's text differs from its review base. */
export function draftHoldsText(doc: Y.Doc): boolean {
  return !blocksEqual(
    readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
    readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
  );
}

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
  /** Stop scheduling and join in-flight judgements and a sweep before closing their store. */
  dispose(): Promise<void>;
};

export type DraftProjectionDiagnostics = {
  /** A projection run failed; the draft is retried on its backoff and never dropped. */
  projectionFailed(input: { draftId: string; cause: unknown }): void;
};

type Outcome = "done" | "drop" | "moved" | "contended";

export function createDraftProjection(input: {
  coordinator: Pick<DraftCoordinator, "readDraft">;
  store: Pick<DraftStore, "writeEffect" | "staleEffectDrafts">;
  diagnostics?: DraftProjectionDiagnostics;
  /** Runs a body outside every ambient transaction and write grant. */
  outsideTransaction<T>(operation: () => T): T;
  maxRuns?: number;
}): DraftProjection {
  let sweep: Promise<number> | null = null;
  let disposed = false;

  const judgements = createKeyedCoalescer<string>({
    debounceMs: DEBOUNCE_MS,
    maxMs: MAX_WAIT_MS,
    maxConcurrent: input.maxRuns ?? MAX_RUNS,
    backoff: { baseMs: BACKOFF_MS, maxMs: MAX_BACKOFF_MS },
    outsideTransaction: input.outsideTransaction,
    run: async (draftId) => {
      const outcome = await judge(draftId);
      // A key committed between the judgement and its guarded write: judge the new revision now.
      if (outcome === "moved") return "again";
      return outcome === "contended" ? "retry" : undefined;
    },
    onError: (draftId, cause) => input.diagnostics?.projectionFailed({ draftId, cause }),
  });

  /** One judgement of the draft at its committed revision, and its write. */
  async function judge(draftId: string): Promise<Outcome> {
    let judged:
      | { kind: "done" }
      | { kind: "judged"; write: Parameters<DraftStore["writeEffect"]>[0] };
    try {
      judged = await input.coordinator.readDraft(draftId, async (doc, snapshot) => {
        // A thread peer carries no effect.
        if (snapshot.kind !== "work_draft") return { kind: "done" as const };
        const hasEffect = draftHoldsText(doc);
        return {
          kind: "judged" as const,
          write: {
            draftId,
            revision: snapshot.revision,
            hasEffect,
            textChanges: hasEffect
              ? projectReview(
                  diffBlocks(
                    readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
                    readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
                  ),
                ).groups.length
              : 0,
            workId: snapshot.workId,
            rootThreadId: snapshot.rootThreadId,
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
    markDirty: judgements.schedule,

    sweep() {
      if (disposed) return Promise.resolve(0);
      if (sweep) return sweep;
      sweep = (async () => {
        let tracked = 0;
        try {
          let after: StaleEffectCursor | undefined;
          while (!disposed) {
            const page = await input.store.staleEffectDrafts({
              ...(after ? { after } : {}),
              limit: SWEEP_PAGE,
            });
            for (const { draftId } of page) {
              // Already dirty, running, backing off or queued: left to its own entry.
              if (judgements.has(draftId)) continue;
              judgements.schedule(draftId);
              tracked += 1;
            }
            after = page.at(-1);
            if (page.length < SWEEP_PAGE) break;
          }
        } finally {
          sweep = null;
        }
        return tracked;
      })();
      return sweep;
    },

    flush: judgements.flush,

    async dispose() {
      disposed = true;
      await Promise.all([judgements.stop(), ...(sweep ? [sweep] : [])]);
    },
  };
}
