/** `@meridian/agent-edit/diff`: the pure block and word diff, and the minimal Yjs block writer. */

export { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
export { blocksEqual } from "./equal.js";
export { heldBlocks, readBlocks } from "./fragments.js";
export { diffKeys, wordDiff } from "./tokens.js";
export { countWords } from "./word-count.js";
export { writeBlocks } from "./writer.js";
