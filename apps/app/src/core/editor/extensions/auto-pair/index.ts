/**
 * Auto-pairing: what the editor writes when a writer types an opener.
 *
 * The registry is the public surface — a lane that wants a new pair adds a row
 * to [`auto-pairs.ts`](auto-pairs.ts).
 */

export { AutoPairExtension, autoPairPluginKey } from "./AutoPairExtension";
export {
  type AutoPairContext,
  type AutoPairSpec,
  autoPairForOpener,
  EDITOR_AUTO_PAIRS,
  resolveAutoPairContext,
  shouldAutoClose,
} from "./auto-pairs";
