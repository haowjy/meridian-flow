/**
 * Ahead refs in a draft's text, registered in that draft (contract §10.7, §10.8).
 *
 * A writer's link typed in a draft's review room mints its ahead ref on the client, so
 * nothing registers it. After each admitted writer update the branch is read, debounced,
 * and every `ahead:` key in it is registered with the draft's id: the registry settles it
 * in the draft's view when the draft has its target, so the draft's own text reads right
 * soon after the writer types. A lost debounce (crash, shutdown) is repaired by the next
 * admitted update and by Apply, which never relies on this path: its prerequisite,
 * `prepareDraftLinkPublication`, registers every ref in the branches it is about to
 * publish and records the cut it read, which Apply's staging fences.
 *
 * Registration is idempotent per (ahead id, draft), so refs that already have a registry
 * row (a live mint pasted into the draft) are registered again, never dropped.
 */
import { type DraftId, parseLinkRef, resolveDocumentHref } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { BranchCoordinator, BranchSnapshot } from "./branch-coordinator.js";
import type { Drafts } from "./drafts.js";
import type { AheadRefRegistrar } from "./ports/document-link-scope.js";

/** One branch as the prerequisite read it: what Apply's staging compares before it writes. */
export type DraftBranchCut = {
  branchId: string;
  documentId: DocumentId;
  generation: number;
  /** The branch's highest journal id at this generation; null when it has none. */
  lastJournalId: number | null;
};

/** The branches a publication read, all registered in `draftId`. */
export type DraftLinkCut = { draftId: DraftId; branches: readonly DraftBranchCut[] };

/** Reads a branch's journal head under the branch's lease. */
export interface DraftBranchJournalHead {
  lastJournalId(branchId: string, generation: number): Promise<number | null>;
}

export interface DraftBranchAheadRegistration {
  /** After an admitted writer update: registers the branch's refs, debounced per branch. */
  schedule(branchId: string): void;
  /** Reads the branch now and registers its refs in its Work's active draft. */
  registerDraftBranchAheads(branchId: string): Promise<void>;
  /**
   * Apply's prerequisite (B8): outside any transaction, reads each selected branch at its
   * current state, records its cut, and registers every ahead ref it holds in `draftId`,
   * so the draft's settlement exists for every ref the publication carries. The caller
   * stages under the branches' leases and compares each branch with its cut; a changed
   * branch means the writer typed meanwhile, and the caller repeats this once.
   */
  prepareDraftLinkPublication(input: {
    draftId: DraftId;
    branchIds: readonly string[];
  }): Promise<DraftLinkCut>;
  /** Resolves once every scheduled and running registration has finished. */
  flush(): Promise<void>;
  /** Drops scheduled registrations that haven't started; running ones finish. */
  cancelScheduled(): void;
}

export type DraftBranchAheadDiagnostics = {
  registrationFailed(input: { branchId: string; cause: unknown }): void;
};

export function createDraftBranchAheadRegistration(input: {
  branches: Pick<BranchCoordinator, "readBranch">;
  journal: DraftBranchJournalHead;
  drafts: Pick<Drafts, "activeForWork" | "byIds">;
  registrar: AheadRefRegistrar;
  /** Registration opens its own root transaction, so it never runs inside a caller's. */
  outsideTransaction<T>(operation: () => T): T;
  debounceMs?: number;
  maxDebounceMs?: number;
  diagnostics?: DraftBranchAheadDiagnostics;
}): DraftBranchAheadRegistration {
  const debounceMs = input.debounceMs ?? 2000;
  const maxDebounceMs = input.maxDebounceMs ?? 10000;
  const timers = new Map<
    string,
    { debounce?: NodeJS.Timeout; max?: NodeJS.Timeout; running?: Promise<void>; again?: boolean }
  >();

  /** The branch's ahead refs and its cut, read together under the branch's lease. */
  async function readCut(branchId: string) {
    return input.branches.readBranch(branchId, async (doc, snapshot) => ({
      snapshot,
      refs: aheadRefsIn(doc),
      cut: {
        branchId,
        documentId: snapshot.documentId,
        generation: snapshot.generation,
        lastJournalId: await input.journal.lastJournalId(branchId, snapshot.generation),
      } satisfies DraftBranchCut,
    }));
  }

  /**
   * One batch; if it fails, each ref alone, so one ref that can't register (an address
   * naming a Work that doesn't exist) never keeps the rest from their meaning.
   */
  async function register(
    branchId: string,
    draft: { id: DraftId; projectId: string },
    refs: readonly { aheadId: string; address: string }[],
  ) {
    if (refs.length === 0) return;
    const rows = refs.map((ref) => ({
      ...ref,
      holderProjectId: draft.projectId,
      draftId: draft.id,
    }));
    try {
      await input.outsideTransaction(() => input.registrar.register(rows));
    } catch {
      for (const row of rows) {
        try {
          await input.outsideTransaction(() => input.registrar.register([row]));
        } catch (cause) {
          input.diagnostics?.registrationFailed({ branchId, cause });
        }
      }
    }
  }

  async function draftOfBranch(snapshot: BranchSnapshot) {
    // A work_draft branch belongs to its Work's active draft; one with none has no view.
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active" || !snapshot.workId) {
      return null;
    }
    return input.drafts.activeForWork(snapshot.workId);
  }

  async function registerDraftBranchAheads(branchId: string): Promise<void> {
    const { snapshot, refs } = await readCut(branchId);
    const draft = await draftOfBranch(snapshot);
    if (draft) await register(branchId, draft, refs);
  }

  function run(branchId: string) {
    const entry = timers.get(branchId);
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.max) clearTimeout(entry.max);
    entry.debounce = undefined;
    entry.max = undefined;
    if (entry.running) {
      // An update admitted while one runs reads the branch again once it finishes.
      entry.again = true;
      return;
    }
    entry.running = registerDraftBranchAheads(branchId)
      .catch((cause: unknown) => input.diagnostics?.registrationFailed({ branchId, cause }))
      .finally(() => {
        entry.running = undefined;
        if (entry.again) {
          entry.again = false;
          run(branchId);
        } else if (!entry.debounce && !entry.max) {
          timers.delete(branchId);
        }
      });
  }

  return {
    schedule(branchId) {
      const entry = timers.get(branchId) ?? {};
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => run(branchId), debounceMs);
      entry.max ??= setTimeout(() => run(branchId), maxDebounceMs);
      timers.set(branchId, entry);
    },
    registerDraftBranchAheads,
    async prepareDraftLinkPublication({ draftId, branchIds }) {
      const [draft] = await input.drafts.byIds([draftId]);
      if (!draft) throw new Error(`Draft ${draftId} does not exist`);
      const branches: DraftBranchCut[] = [];
      const refs = new Map<string, string>();
      for (const branchId of [...new Set(branchIds)].sort()) {
        const read = await readCut(branchId);
        branches.push(read.cut);
        for (const ref of read.refs) refs.set(ref.aheadId, ref.address);
      }
      await register(
        branches.map((branch) => branch.branchId).join(","),
        draft,
        [...refs].map(([aheadId, address]) => ({ aheadId, address })),
      );
      return { draftId, branches };
    },
    async flush() {
      while (timers.size > 0) {
        const pending = [...timers];
        for (const [branchId, entry] of pending) if (!entry.running) run(branchId);
        await Promise.all(pending.map(([, entry]) => entry.running));
      }
    },
    cancelScheduled() {
      for (const [branchId, entry] of timers) {
        if (entry.debounce) clearTimeout(entry.debounce);
        if (entry.max) clearTimeout(entry.max);
        entry.debounce = undefined;
        entry.max = undefined;
        entry.again = false;
        if (!entry.running) timers.delete(branchId);
      }
    },
  };
}

/**
 * Every `ahead:` ref in a document's text, with the address its stored href names. A
 * stored ahead href is a full canonical address (`storedHref`), so it reads without the
 * holder, exactly as the link scope loads it.
 */
export function aheadRefsIn(doc: Y.Doc): { aheadId: string; address: string }[] {
  const refs = new Map<string, string>();
  for (const occurrence of extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME))) {
    const ref = occurrence.ref === null ? null : parseLinkRef(occurrence.ref);
    if (ref?.kind !== "ahead" || refs.has(ref.aheadId)) continue;
    const address = resolveDocumentHref(occurrence.href, null)?.uri;
    if (address) refs.set(ref.aheadId, address);
  }
  return [...refs].map(([aheadId, address]) => ({ aheadId, address }));
}
