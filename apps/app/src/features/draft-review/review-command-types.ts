/** Work addresses and item-level command feedback shared by review surfaces. */
export type DraftRef = { projectId: string; ownerKey: string; documentId: string; itemKey: string };
export type ServerRefusal = {
  serverCode?: string;
};
/**
 * One line of what an Apply left out of an item, for the half it explains: `overtaken_<state>`
 * or `left_out_<why>`. `by` is the command that settled it first, which a Restore takes back.
 */
export type ApplyLine = { half: "tree" | "text"; code: string; by?: string };
export type CommandRefusal = {
  code: "apply-refused" | "unapply-refused" | "discard-refused";
} & ServerRefusal;
export type BranchCommandFailure =
  | CommandRefusal
  /**
   * The server answered an Apply and part of the item stayed out: every half's line. `landed`:
   * its other half landed, so the lines are notes beside an applied change, not an error.
   */
  | { code: "apply-left-out"; landed: boolean; lines: readonly ApplyLine[] };
/** A failure the writer reads as a note: what stayed out beside what landed. */
export function isNote(failure: BranchCommandFailure): boolean {
  return failure.code === "apply-left-out" && failure.landed;
}
