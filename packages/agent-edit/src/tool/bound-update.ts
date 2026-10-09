// Admission of a host-bound whole-document update: one set of rules for every door that applies one.
import * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type { JournalAuthority } from "../ports/update-journal.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import type { InternalWriteResult } from "./internal-result.js";
import { status } from "./response-format.js";

/**
 * A whole-document write a host bound outside its transaction (the server's
 * `BoundWrite`, contract §6.2): a Yjs mutation against a certified base,
 * never a desired state, so anything admitted since the base merges with it.
 */
export interface BoundUpdate {
  /**
   * What the update was bound against: the authority generation it was
   * read in (the certificate) and its clocks (the update's dependency).
   * Null: bound fresh, for a document with no blocks.
   */
  readonly base: {
    readonly authority: JournalAuthority;
    readonly stateVector: Uint8Array;
  } | null;
  /** Turns `base` into the bound result. */
  readonly update: Uint8Array;
  /**
   * The overwrite's certified intent, written against the base: its IR, and
   * the provenance facts it implies as an update on top of `update`.
   */
  readonly certified: {
    readonly ir: SemanticEditIRV1;
    readonly provenance: Uint8Array;
  } | null;
}

export type BoundRefusal =
  /** The base's generation was replaced (a restore), even if every clock survived. */
  | "authority_replaced"
  /** The document lacks clocks the update depends on. */
  | "base_missing"
  /** A fresh write, but the document holds blocks it never saw. */
  | "not_empty";

/**
 * Admit `bound` into `doc`: a private copy of a document taken under its
 * lock, whose authority generation is `authority` (undefined: the host keeps
 * no generations). On a refusal `doc` may be half-changed; discard it.
 *
 * The certificate and clock containment are separate checks: a restore can
 * keep every clock yet replace the generation, and a state vector says
 * nothing of which generation it is in. `certified` admits the overwrite's
 * provenance with the update; a writer's fresh save applies the update alone.
 */
export function admitBoundUpdate(
  doc: Y.Doc,
  bound: BoundUpdate,
  input: {
    authority: JournalAuthority | undefined;
    model: Pick<AgentEditModel, "getBlocks">;
    origin: unknown;
    certified: boolean;
  },
): BoundRefusal | null {
  const { base } = bound;
  if (base === null) {
    if (input.model.getBlocks(toDocHandle(doc)).length > 0) return "not_empty";
  } else {
    if (input.authority && !sameAuthority(input.authority, base.authority)) {
      return "authority_replaced";
    }
    if (!containsClocks(doc, base.stateVector)) return "base_missing";
  }
  return mergeBoundUpdate(doc, bound, input.origin, input.certified) ? null : "base_missing";
}

/**
 * Merge `bound` into `doc` without admitting it: staging on a copy whose
 * admission is decided under the lock. False when a dependency is missing.
 */
export function mergeBoundUpdate(
  doc: Y.Doc,
  bound: BoundUpdate,
  origin: unknown,
  certified: boolean,
): boolean {
  Y.applyUpdate(doc, bound.update, origin);
  if (certified && bound.certified) Y.applyUpdate(doc, bound.certified.provenance, origin);
  return doc.store.pendingStructs === null && doc.store.pendingDs === null;
}

/** A refused bound write's result: its host binds the write again. */
export function boundRefusalResult(documentId: string, refusal: BoundRefusal): InternalWriteResult {
  return status("invalid_write", REFUSAL_MESSAGES[refusal], {
    error: { type: "bound_base", code: refusal, documentId },
  });
}

const REFUSAL_MESSAGES: Record<BoundRefusal, string> = {
  authority_replaced: "The document was restored; bind the write again.",
  base_missing: "The document lacks the state this write was bound against; bind it again.",
  not_empty: "The document has content this fresh write never saw; bind it again.",
};

function sameAuthority(left: JournalAuthority, right: JournalAuthority): boolean {
  return left.authorityId === right.authorityId && left.generation === right.generation;
}

function containsClocks(doc: Y.Doc, stateVector: Uint8Array): boolean {
  const have = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of Y.decodeStateVector(stateVector)) {
    if ((have.get(client) ?? 0) < clock) return false;
  }
  return true;
}
