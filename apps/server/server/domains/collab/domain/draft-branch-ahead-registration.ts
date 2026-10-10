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
 * publish and records the cut it read, which Apply's staging fences. The cut is each
 * branch's full-state fingerprint (F18): a live pull rewrites a branch with no journal
 * row and no new generation, and a deletion moves no state vector, so nothing less
 * proves the staged text is the text whose refs were registered.
 *
 * Registration is idempotent per (ahead id, draft), so refs that already have a registry
 * row (a live mint pasted into the draft) are registered again, never dropped.
 */
import { type DraftId, parseLinkRef, resolveDocumentHref } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import { UnregistrableAheadRefError } from "../../context/ports/link-ahead-registry.js";
import type { BranchCoordinator, BranchSnapshot } from "./branch-coordinator.js";
import { fullStateFingerprint } from "./branch-push-transition.js";
import type { Drafts } from "./drafts.js";
import type { AheadRefRegistrar } from "./ports/document-link-scope.js";

/** One branch as the prerequisite read it: what Apply's staging compares before it writes. */
export type DraftBranchCut = {
  branchId: string;
  documentId: DocumentId;
  /**
   * `fullStateFingerprint` of the branch under its lease, read with the refs registered
   * (deletions count). Staging compares the fingerprint of the branch it stages under the
   * same lease; any difference means the text changed since registration: run again.
   */
  fingerprint: string;
};

/** The branches a publication read, every ref in them registered in `draftId`. */
export type DraftLinkCut = { draftId: DraftId; branches: readonly DraftBranchCut[] };

/** A ref in the cut that didn't register, and why. */
export type DraftLinkRegistrationFailure = { aheadId: string; address: string; reason: string };

/**
 * The prerequisite's answer. `ready` lets Apply stage. `unregistrable` refs are ones the
 * registry refuses for good (F20: a Work that doesn't exist, an inadmissible address):
 * such an address never showed D's document in D's view, so it has no meaning to keep,
 * and Apply publishes it unbound rather than refusing the writer's Apply over a link.
 * `registration_failed` is a failure that may pass (connection, timeout, lock): no cut,
 * the caller surfaces it and the writer retries.
 */
export type DraftLinkPublication =
  | {
      status: "ready";
      cut: DraftLinkCut;
      unregistrable: readonly DraftLinkRegistrationFailure[];
    }
  | {
      status: "registration_failed";
      draftId: DraftId;
      failed: readonly DraftLinkRegistrationFailure[];
      unregistrable: readonly DraftLinkRegistrationFailure[];
    };

export interface DraftBranchAheadRegistration {
  /** After an admitted writer update: registers the branch's refs, debounced per branch. */
  schedule(branchId: string): void;
  /** Reads the branch now and registers its refs in its Work's active draft. */
  registerDraftBranchAheads(branchId: string): Promise<void>;
  /**
   * Apply's prerequisite (B8): outside any transaction, reads each selected branch at its
   * current state, records its cut, and registers every ahead ref it holds in `draftId`,
   * so the draft's settlement exists for every ref the publication carries. Valid refs
   * register even when another fails. A ref the registry refuses for good is listed as
   * `unregistrable` and doesn't block; any other failure answers `registration_failed`.
   * The caller stages under the branches' leases and compares each branch's fingerprint
   * with its cut; a changed branch (the writer typed, a live pull landed) means repeat.
   */
  prepareDraftLinkPublication(input: {
    draftId: DraftId;
    branchIds: readonly string[];
  }): Promise<DraftLinkPublication>;
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

  /** The branch's ahead refs and its cut, read together under the branch's lease. */
  async function readCut(branchId: string) {
    return input.branches.readBranch(branchId, async (doc, snapshot) => {
      const { refs, fingerprint } = branchCutOf(doc);
      return {
        snapshot,
        refs,
        cut: { branchId, documentId: snapshot.documentId, fingerprint } satisfies DraftBranchCut,
      };
    });
  }

  /**
   * One batch; if it fails, each ref alone, so one ref that can't register (an address
   * naming a Work that doesn't exist) never keeps the rest from their meaning. Returns
   * the refs that didn't register, split by the registry's typed refusal: `unregistrable`
   * never will, `failed` might; each caller decides what that means.
   */
  async function register(
    draft: { id: DraftId; projectId: string },
    refs: readonly { aheadId: string; address: string }[],
  ): Promise<{
    failed: DraftLinkRegistrationFailure[];
    unregistrable: DraftLinkRegistrationFailure[];
  }> {
    const outcome = {
      failed: [] as DraftLinkRegistrationFailure[],
      unregistrable: [] as DraftLinkRegistrationFailure[],
    };
    if (refs.length === 0) return outcome;
    const rows = refs.map((ref) => ({
      ...ref,
      holderProjectId: draft.projectId,
      draftId: draft.id,
    }));
    try {
      await input.outsideTransaction(() => input.registrar.register(rows));
      return outcome;
    } catch {
      for (const row of rows) {
        try {
          await input.outsideTransaction(() => input.registrar.register([row]));
        } catch (cause) {
          const failure = {
            aheadId: row.aheadId,
            address: row.address,
            reason: cause instanceof Error ? cause.message : String(cause),
          };
          if (cause instanceof UnregistrableAheadRefError) outcome.unregistrable.push(failure);
          else outcome.failed.push(failure);
        }
      }
      return outcome;
    }
  }

  async function draftOfBranch(snapshot: BranchSnapshot) {
    // An active work_draft branch's own draft; a closed one has no view to register in.
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active") return null;
    const [draft] = await input.drafts.byIds([snapshot.draftId]);
    return draft?.status === "active" ? draft : null;
  }

  /**
   * Best effort: a ref that can't register is reported. Apply's prerequisite registers
   * again; it fails only on a failure that may pass, never on an unregistrable ref (F20).
   */
  async function registerDraftBranchAheads(branchId: string): Promise<void> {
    const { snapshot, refs } = await readCut(branchId);
    const draft = await draftOfBranch(snapshot);
    if (!draft) return;
    const { failed, unregistrable } = await register(draft, refs);
    for (const failure of [...failed, ...unregistrable]) {
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
      const { failed, unregistrable } = await register(
        draft,
        [...refs].map(([aheadId, address]) => ({ aheadId, address })),
      );
      return failed.length > 0
        ? { status: "registration_failed", draftId, failed, unregistrable }
        : { status: "ready", cut: { draftId, branches }, unregistrable };
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
 * What a branch's text says for its link cut (F18): every ahead ref in it and its
 * full-state fingerprint. Registration records it; Apply's staging computes it again from
 * the branch it stages and compares, so both sides must compute it here.
 */
export function branchCutOf(doc: Y.Doc): {
  refs: { aheadId: string; address: string }[];
  fingerprint: string;
} {
  return { refs: aheadRefsIn(doc), fingerprint: fullStateFingerprint(doc) };
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
