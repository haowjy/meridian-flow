/** `@meridian/agent-edit/diff`: the pure block and word diff. */

export { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
export { blocksEqual } from "./equal.js";
export { diffKeys, type WordPart, wordDiff } from "./tokens.js";
export { countWords } from "./word-count.js";
