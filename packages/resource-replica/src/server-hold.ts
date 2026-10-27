/**
 * What the server holds under an id this device minted, as its answers prove.
 *
 * Both journals (documents and folders) record it once and read it everywhere a decision depends on
 * it: whether a placement is a create or a move, whether deleting needs the server, whether a row
 * is provisional, whether the id must be replaced. Nothing derives it from `canonical`, `lifecycle`
 * or the shape of an attempt's outcome, so a document and a folder cannot disagree about it.
 */
import type { NamespaceAttempt } from "./resource-records";

/**
 * - `local`: no answer shows the server holds the id, so the next send is a create (never sent, or
 *   every create it sent was refused).
 * - `uncertain`: a create was sent and not answered; it may have landed.
 * - `held`: the server accepted the id (or a catalog lists it); `canonical` may still wait for the
 *   catalog. Placements are moves from here on.
 * - `spent`: the server holds the id where the writer cannot reach it (deleted, hidden, archived
 *   or deleted Work, lost grant, another kind). It never succeeds again; the work moves to a new id.
 */
export type ServerHold = "local" | "uncertain" | "held" | "spent";

/**
 * The hold once `attempt` is sent (no outcome) or answered. Only a create says anything about the id:
 * a refused move leaves a held id held. A typed refusal means the server holds nothing under the id
 * (the create routes answer a held id before any refusal), so the id is free again.
 */
export function holdAfterAttempt(hold: ServerHold, attempt: NamespaceAttempt): ServerHold {
  if (attempt.request.kind !== "create" && attempt.request.kind !== "create-folder") return hold;
  const { outcome } = attempt;
  if (!outcome) return "uncertain";
  if (outcome.kind === "refusal") return "local";
  if (outcome.kind === "operation") return hold;
  return outcome.result.status === "conflict" ? "spent" : "held";
}

/** Deleting something the server may hold needs the server; otherwise it settles on this device. */
export function deleteNeedsServer(hold: ServerHold): boolean {
  return hold === "held" || hold === "uncertain";
}
