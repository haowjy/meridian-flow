/**
 * Auto-pairing: what the editor writes when a writer types an opener.
 *
 * The registry is the public surface — a lane that wants a new pair adds a row
 * to [`auto-pairs.ts`](auto-pairs.ts). `autoClosedRunLength` is the one seam a
 * surface outside this folder needs: a range replacement that ends where the
 * caret is has to swallow the closers that were written for it.
 */

export { AutoPairExtension, autoClosedRunLength, autoPairPluginKey } from "./AutoPairExtension";
export {
  type AutoPairContext,
  type AutoPairSpec,
  autoPairForOpener,
  EDITOR_AUTO_PAIRS,
  resolveAutoPairContext,
  shouldAutoClose,
} from "./auto-pairs";
