/**
 * The composer's `@`: trigger detection, caret geometry, and the menu it opens.
 *
 * A thin host over shared parts. What a query means is `@/core/references`,
 * what an open menu does with a key is `@/core/completion`, and the rows are
 * the same listbox the manuscript renders; this directory owns only what a
 * `<textarea>` has to answer for itself.
 */

export { ComposerReferenceMenu } from "./ComposerReferenceMenu";
export {
  type ComposerReferences,
  type ComposerReferencesOptions,
  useComposerReferences,
} from "./useComposerReferences";
