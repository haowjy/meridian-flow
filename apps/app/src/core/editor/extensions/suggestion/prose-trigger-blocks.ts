/**
 * The blocks a typed-under menu may open in.
 *
 * Prose the writer types sentences into. A heading, a list item, a quote, and
 * a table cell all resolve to a paragraph, so the one name covers every place
 * §5.5 and §5.7 expect a trigger. Anything absent is denied: a `jsx_leaf`'s text is a
 * component's props, not a sentence, and an unlisted future block stays silent
 * until it is deliberately let in.
 *
 * One set for both menus. `/` and `@` differ in what else they demand — a
 * word boundary, an enclosing link — but not in what counts as prose, and two
 * lists of the same name would have drifted the first time a lane let a
 * new block in.
 */

export const PROSE_TRIGGER_BLOCKS: ReadonlySet<string> = new Set(["paragraph"]);
