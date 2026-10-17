/**
 * Ahead refs in a draft branch's text, registered globally (contract §10.7).
 *
 * A writer's link typed in a draft's review room mints its ahead ref on the client, so
 * nothing registers it. After each admitted writer update the branch is read, debounced,
 * and every `ahead:` key in it is registered, best effort: a target created live and then
 * moved before Apply would otherwise leave the link at the old path. Drafts store nothing
 * about the ref and Apply needs no prerequisite: after publication the derive sweep
 * registers anything this missed.
 */
import { parseLinkRef, resolveDocumentHref } from "@meridian/contracts";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchSnapshot } from "./branch-store.js";
import type { Drafts } from "./drafts.js";
import type { AheadRefRegistrar } from "./ports/document-link-scope.js";

export interface DraftBranchAheadRegistration {
  /** After an admitted writer update: registers the branch's refs, debounced per branch. */
  schedule(branchId: string): void;
  /** Reads the branch now and registers its refs. */
  registerDraftBranchAheads(branchId: string): Promise<void>;
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
  drafts: Pick<Drafts, "byIds">;
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

  /** One batch; if it fails, each ref alone, so one ref that can't register never blocks the rest. */
  async function register(
    draft: { projectId: string },
    refs: readonly { aheadId: string; address: string }[],
  ): Promise<{ aheadId: string; address: string; reason: string }[]> {
    if (refs.length === 0) return [];
    const rows = refs.map((ref) => ({ ...ref, holderProjectId: draft.projectId }));
    try {
      await input.outsideTransaction(() => input.registrar.register(rows));
      return [];
    } catch {
      const failed = [];
      for (const row of rows) {
        try {
          await input.outsideTransaction(() => input.registrar.register([row]));
        } catch (cause) {
          failed.push({
            aheadId: row.aheadId,
            address: row.address,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      return failed;
    }
  }

  async function draftOfBranch(snapshot: BranchSnapshot) {
    // An active work_draft branch's own draft; a closed one has no view to register in.
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active") return null;
    const [draft] = await input.drafts.byIds([snapshot.draftId]);
    return draft?.status === "active" ? draft : null;
  }

  async function registerDraftBranchAheads(branchId: string): Promise<void> {
    const { snapshot, refs } = await input.branches.readBranch(branchId, async (doc, snapshot) => ({
      snapshot,
      refs: aheadRefsIn(doc),
    }));
    const draft = await draftOfBranch(snapshot);
    if (!draft) return;
    for (const failure of await register(draft, refs)) {
      input.diagnostics?.registrationFailed({ branchId, cause: failure });
    }
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
