/** Live→Work draft pulls (debounced and at tool boundaries). */

import { contentMerge, type RuleCounts } from "@meridian/agent-edit/content-merge";
import {
  blocksEqual,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { DocumentId } from "@meridian/contracts/runtime";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DraftCoordinator } from "./draft-coordinator.js";

export type WorkDraftLookup = {
  listActiveWorkDraftIds(documentId: DocumentId): Promise<string[]>;
};

export type DraftPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  /** Stop scheduling and join pulls already in flight before their store is destroyed. */
  shutdown(): Promise<void>;
  flushLivePull(documentId: DocumentId): Promise<void>;
};

export type DraftPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
  /** What a pull's content merge did: how often each rule fired, and the live words the draft overrode. */
  merged(input: { documentId: DocumentId; rules: RuleCounts; overrode: number }): void;
};

export function createDraftPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  draftCoordinator: DraftCoordinator;
  drafts: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  liveJournal: Pick<UpdateJournal, "read">;
  diagnostics?: DraftPullDiagnostics;
}): DraftPullService {
  let stopped = false;
  const debounceMs = input.debounceMs ?? 2000;
  const maxDebounceMs = input.maxDebounceMs ?? 10000;
  const timers = new Map<
    string,
    {
      debounce?: NodeJS.Timeout;
      max?: NodeJS.Timeout;
      running?: Promise<void>;
      queued?: Promise<void>;
    }
  >();

  const schema = buildDocumentSchema();

  async function committedLive(documentId: DocumentId): Promise<Y.Doc> {
    const cut = await input.liveJournal.read(documentId);
    const doc = new Y.Doc({ gc: false });
    try {
      if (cut.checkpoint) Y.applyUpdate(doc, cut.checkpoint);
      for (const row of cut.updates) Y.applyUpdate(doc, row.update);
      return doc;
    } catch (cause) {
      doc.destroy();
      throw cause;
    }
  }

  async function pullLive(documentId: DocumentId): Promise<void> {
    const drafts = await input.drafts.listActiveWorkDraftIds(documentId);
    if (!drafts.length) return;
    const live = await committedLive(documentId);
    try {
      const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
      for (const draftId of drafts) {
        const base = await input.draftCoordinator.loadBase(draftId);
        if (base.snapshot.status !== "active") continue;
        if (
          blocksEqual(
            readBlocks(base.replica.doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
            blocks,
          )
        )
          continue;
        const write = input.draftCoordinator.prepareAppend(base, [], {
          work: "any",
          async authorServerRows(prefix) {
            // A committed Apply in this prefix also committed its live row. Read live after
            // the draft lock, without taking live's lock or importing any of its Yjs identity.
            const current = await committedLive(documentId);
            try {
              const nextBase = readBlocks(
                current.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
                schema,
              );
              const reviewBase = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
              const oldBase = readBlocks(reviewBase, schema);
              if (blocksEqual(oldBase, nextBase)) return [];
              const fragment = prefix.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
              const merged = contentMerge(schema, oldBase, nextBase, readBlocks(fragment, schema));
              input.diagnostics?.merged({
                documentId,
                rules: merged.rules,
                overrode: merged.overrode,
              });
              return captureMutationUpdates(prefix, () =>
                prefix.transact(() => {
                  writeBlocks(fragment, schema, merged.blocks);
                  writeBlocks(reviewBase, schema, nextBase);
                }),
              );
            } finally {
              current.destroy();
            }
          },
        });
        try {
          await write.persist();
          await write.transfer();
        } finally {
          write.dispose();
        }
      }
    } finally {
      live.destroy();
    }
  }

  async function run(documentId: DocumentId): Promise<void> {
    if (stopped) return;
    const current = timers.get(documentId);
    if (current?.running) {
      // A joiner needs a snapshot captured after its call, not the in-flight
      // snapshot that may predate a writer edit. Coalesce joins into one rerun.
      const running = current.running;
      current.queued ??= input.outsideTransaction(() => {
        const rerun = () => {
          current.queued = undefined;
          return run(documentId);
        };
        return running.then(rerun, rerun);
      });
      return current.queued;
    }
    const entry = current ?? {};
    const running = input.outsideTransaction(() =>
      pullLive(documentId)
        .then(() => {
          // A queued snapshot may include newer edits; its retries still need these timers.
          if (entry.queued) return;
          if (entry.debounce) clearTimeout(entry.debounce);
          if (entry.max) clearTimeout(entry.max);
          entry.debounce = undefined;
          entry.max = undefined;
        })
        .finally(() =>
          input.outsideTransaction(() => {
            entry.running = undefined;
            if (!entry.queued && !entry.debounce && !entry.max) timers.delete(documentId);
          }),
        ),
    );
    entry.running = running;
    timers.set(documentId, entry);
    return running;
  }

  function backgroundPull(documentId: DocumentId): void {
    void run(documentId).catch((cause: unknown) => {
      input.diagnostics?.backgroundFailed({ documentId, cause });
    });
  }

  function armDebounce(documentId: DocumentId, entry: NonNullable<ReturnType<typeof timers.get>>) {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      backgroundPull(documentId);
    }, debounceMs);
  }

  return {
    scheduleLivePull(documentId) {
      if (stopped) return;
      const entry = timers.get(documentId) ?? {};
      if (entry.running) backgroundPull(documentId);
      armDebounce(documentId, entry);
      entry.max ??= setTimeout(() => {
        entry.max = undefined;
        backgroundPull(documentId);
      }, maxDebounceMs);
      timers.set(documentId, entry);
    },

    cancelScheduledPulls() {
      for (const [documentId, entry] of timers) {
        if (entry.debounce) clearTimeout(entry.debounce);
        if (entry.max) clearTimeout(entry.max);
        entry.debounce = undefined;
        entry.max = undefined;
        if (!entry.running && !entry.queued) timers.delete(documentId);
      }
    },

    async shutdown() {
      stopped = true;
      this.cancelScheduledPulls();
      // A queued rerun observes stopped before touching the store. Failures are already
      // reported by the background caller; teardown must join every other pull as well.
      await Promise.allSettled(
        [...timers.values()].flatMap((entry) => [entry.running, entry.queued].filter(Boolean)),
      );
    },

    flushLivePull(documentId) {
      return run(documentId);
    },
  };
}
