/**
 * Live→Work draft pulls: a Live commit pushes to the draft rooms open at that moment (debounced);
 * a reader that shows a draft's text catches that one draft up first.
 */

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

export type DraftPullService = {
  /**
   * Live committed. After the debounce, catches up each draft of the document that has a room
   * open then. Never waits: a draft nobody has open catches up when it is next read.
   */
  liveCommitted(documentId: DocumentId): void;
  /**
   * Brings Live's committed text into the draft's base and prose. A caller joining a running
   * pull waits for a rerun that reads Live after its call. Never call it inside a command's
   * transaction: it opens connections of its own.
   */
  catchUpDraft(draftId: string): Promise<void>;
  /** Drops debounced pushes that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  /** Stop scheduling and join pulls already in flight before their store is destroyed. */
  shutdown(): Promise<void>;
};

export type DraftPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
  /** What a pull's content merge did: how often each rule fired, and the live words the draft overrode. */
  merged(input: { documentId: DocumentId; rules: RuleCounts; overrode: number }): void;
};

export function createDraftPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  draftCoordinator: DraftCoordinator;
  /** The document's Work drafts with a room open or loading in this process. */
  openDraftRooms(documentId: DocumentId): Promise<string[]>;
  debounceMs?: number;
  maxDebounceMs?: number;
  liveJournal: Pick<UpdateJournal, "read">;
  diagnostics?: DraftPullDiagnostics;
}): DraftPullService {
  let stopped = false;
  const debounceMs = input.debounceMs ?? 2000;
  const maxDebounceMs = input.maxDebounceMs ?? 10000;
  const scheduled = new Map<DocumentId, { debounce?: NodeJS.Timeout; max?: NodeJS.Timeout }>();
  const pulls = new Map<string, { running?: Promise<void>; queued?: Promise<void> }>();
  const pushes = new Set<Promise<void>>();

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

  async function pullDraft(draftId: string): Promise<void> {
    const base = await input.draftCoordinator.loadBase(draftId);
    const documentId = base.snapshot.documentId as DocumentId;
    const live = await committedLive(documentId);
    try {
      const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
      if (
        blocksEqual(
          readBlocks(base.replica.doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
          blocks,
        )
      )
        return;
      const write = input.draftCoordinator.prepareAppend(base, [], {
        // A server rebase is not an incoming edit: an archived Work's open draft follows Live too.
        work: "any",
        async authorServerRows(prefix) {
          // A committed Apply in this prefix also committed its live row. Read live after
          // the draft lock, without taking live's lock or importing any of its Yjs identity.
          const current = await committedLive(documentId);
          try {
            const nextBase = readBlocks(current.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
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
    } finally {
      live.destroy();
    }
  }

  function catchUpDraft(draftId: string): Promise<void> {
    if (stopped) return Promise.resolve();
    const current = pulls.get(draftId);
    if (current?.running) {
      // A joiner needs a snapshot captured after its call, not the in-flight
      // snapshot that may predate a writer edit. Coalesce joins into one rerun.
      const running = current.running;
      current.queued ??= input.outsideTransaction(() => {
        const rerun = () => {
          current.queued = undefined;
          return catchUpDraft(draftId);
        };
        return running.then(rerun, rerun);
      });
      return current.queued;
    }
    const entry = current ?? {};
    entry.running = input.outsideTransaction(() =>
      pullDraft(draftId).finally(() =>
        input.outsideTransaction(() => {
          entry.running = undefined;
          if (!entry.queued) pulls.delete(draftId);
        }),
      ),
    );
    pulls.set(draftId, entry);
    return entry.running;
  }

  function push(documentId: DocumentId): void {
    const entry = scheduled.get(documentId);
    if (entry?.debounce) clearTimeout(entry.debounce);
    if (entry?.max) clearTimeout(entry.max);
    scheduled.delete(documentId);
    const report = (cause: unknown) => input.diagnostics?.backgroundFailed({ documentId, cause });
    const pushed: Promise<void> = input
      .outsideTransaction(() => input.openDraftRooms(documentId))
      .then((draftIds) =>
        Promise.all(draftIds.map((draftId) => catchUpDraft(draftId).catch(report))),
      )
      .then(() => undefined, report)
      .finally(() => pushes.delete(pushed));
    pushes.add(pushed);
  }

  return {
    liveCommitted(documentId) {
      if (stopped) return;
      const entry = scheduled.get(documentId) ?? {};
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => push(documentId), debounceMs);
      entry.max ??= setTimeout(() => push(documentId), maxDebounceMs);
      scheduled.set(documentId, entry);
    },

    catchUpDraft,

    cancelScheduledPulls() {
      for (const entry of scheduled.values()) {
        if (entry.debounce) clearTimeout(entry.debounce);
        if (entry.max) clearTimeout(entry.max);
      }
      scheduled.clear();
    },

    async shutdown() {
      stopped = true;
      this.cancelScheduledPulls();
      // A queued rerun observes stopped before touching the store. Failures are already
      // reported by the push that ran them; teardown must join every other pull as well.
      await Promise.allSettled([
        ...pushes,
        ...[...pulls.values()].flatMap((entry) => [entry.running, entry.queued].filter(Boolean)),
      ]);
    },
  };
}
