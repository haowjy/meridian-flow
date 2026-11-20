/**
 * Ahead refs in a draft's text, registered globally (contract §10.7).
 *
 * A writer's link typed in a draft's review room mints its ahead ref on the client, so
 * nothing registers it. After each admitted writer update the draft is read, debounced,
 * and every `ahead:` key in it is registered, best effort: a target created live and then
 * moved before Apply would otherwise leave the link at the old path. Drafts store nothing
 * about the ref and Apply needs no prerequisite: after the Apply the derive sweep
 * registers anything this missed.
 */
import { parseLinkRef, resolveDocumentHref } from "@meridian/contracts";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import { createKeyedCoalescer } from "../../../shared/keyed-coalescer.js";
import type { Branches } from "./branches.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftSnapshot } from "./draft-store.js";
import type { AheadRefRegistrar } from "./ports/document-link-scope.js";

export interface DraftAheadRegistration {
  /** After an admitted writer update: registers the draft's refs, debounced per draft. */
  schedule(draftId: string): void;
  /** Assertion-time convergence, distinct from shutdown. */
  flush(): Promise<void>;
  /** Stops admission, cancels queued registrations, and joins running work. */
  shutdown(): Promise<void>;
}

export type DraftAheadDiagnostics = {
  registrationFailed(input: { draftId: string; cause: unknown }): void;
};

export function createDraftAheadRegistration(input: {
  drafts: Pick<DraftCoordinator, "readDraft">;
  branches: Pick<Branches, "byIds">;
  registrar: AheadRefRegistrar;
  /** Registration opens its own root transaction, so it never runs inside a caller's. */
  outsideTransaction<T>(operation: () => T): T;
  debounceMs?: number;
  maxDebounceMs?: number;
  diagnostics?: DraftAheadDiagnostics;
}): DraftAheadRegistration {
  /** One batch; if it fails, each ref alone, so one ref that can't register never blocks the rest. */
  async function register(
    branch: { projectId: string },
    refs: readonly { aheadId: string; address: string }[],
  ): Promise<{ aheadId: string; address: string; reason: string }[]> {
    if (refs.length === 0) return [];
    const rows = refs.map((ref) => ({ ...ref, holderProjectId: branch.projectId }));
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

  async function branchOfDraft(snapshot: DraftSnapshot) {
    if (snapshot.kind !== "work_draft") return null;
    const [branch] = await input.branches.byIds([snapshot.branchId]);
    return branch?.status === "active" ? branch : null;
  }

  async function registerDraftAheads(draftId: string): Promise<void> {
    const { snapshot, refs } = await input.drafts.readDraft(draftId, async (doc, snapshot) => ({
      snapshot,
      refs: aheadRefsIn(doc),
    }));
    const branch = await branchOfDraft(snapshot);
    if (!branch) return;
    for (const failure of await register(branch, refs)) {
      input.diagnostics?.registrationFailed({ draftId, cause: failure });
    }
  }

  const registrations = createKeyedCoalescer<string>({
    debounceMs: input.debounceMs ?? 2000,
    maxMs: input.maxDebounceMs ?? 10000,
    outsideTransaction: input.outsideTransaction,
    run: registerDraftAheads,
    onError: (draftId, cause) => input.diagnostics?.registrationFailed({ draftId, cause }),
  });

  return {
    schedule: registrations.schedule,
    flush: registrations.flush,
    shutdown: registrations.stop,
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
